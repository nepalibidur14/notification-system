import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailerSendService } from '../providers/mailersend/mailersend.service.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerSend: MailerSendService,
  ) {}

  async create(dto: CreateNotificationDto) {
    const toEmail = dto.to.email.trim().toLowerCase();

    // We ignore dto.to.name in the hash (as we discussed)
    const canonicalPayload = {
      tenantId: dto.tenantId,
      eventType: dto.eventType,
      priority: dto.priority,
      toEmail,
      templateId: dto.templateId,
      variables: this.sortObjectDeep(dto.variables),
    };

    const requestHash = this.sha256Json(canonicalPayload);

    const expiresAt = dto.ttlSeconds
      ? new Date(Date.now() + dto.ttlSeconds * 1000)
      : null;

    try {
      const created = await this.prisma.notification.create({
        data: {
          tenantId: dto.tenantId,
          idempotencyKey: dto.idempotencyKey,
          requestHash,

          eventType: dto.eventType,
          // Prisma enum expects "P0" | "P1" | "P2"
          priority: dto.priority,
          toEmail,
          toName: dto.to.name ?? null,
          templateId: dto.templateId,
          variables: dto.variables,

          // status defaults to ACCEPTED in schema
          expiresAt,
        },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });

      return {
        notificationId: created.id,
        status: created.status,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
        idempotencyReused: false,
      };
    } catch (err: any) {
      // Prisma unique constraint violation for @@unique([tenantId, idempotencyKey])
      if (err?.code === 'P2002') {
        const existing = await this.prisma.notification.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: dto.tenantId,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          select: {
            id: true,
            status: true,
            expiresAt: true,
            createdAt: true,
            requestHash: true,
          },
        });

        // Shouldn't happen, but guard anyway
        if (!existing) throw err;

        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            existingNotificationId: existing.id,
          });
        }

        return {
          notificationId: existing.id,
          status: existing.status,
          expiresAt: existing.expiresAt,
          createdAt: existing.createdAt,
          idempotencyReused: true,
        };
      }

      throw err;
    }
  }

  async claimNextPerTenant() {
    try {
      const rows = await this.prisma.$queryRaw<any[]>`
    WITH candidate_tenant AS (
      SELECT "tenantId"
      FROM "Notification"
      WHERE "status" = 'ACCEPTED'
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
      GROUP BY "tenantId"
      ORDER BY MIN("createdAt") ASC
      LIMIT 1
    ),
    candidate AS (
      SELECT n."id"
      FROM "Notification" n
      JOIN candidate_tenant t ON t."tenantId" = n."tenantId"
      WHERE n."status" = 'ACCEPTED'
        AND (n."expiresAt" IS NULL OR n."expiresAt" > NOW())
      ORDER BY
        -- priority base
        (CASE n."priority"
          WHEN 'P0' THEN 100
          WHEN 'P1' THEN 50
          WHEN 'P2' THEN 10
          ELSE 0
        END)
        +
        -- aging bonus (minutes waiting * 0.5)
        (EXTRACT(EPOCH FROM (NOW() - n."createdAt")) / 60.0) * 0.5
        DESC,
        n."createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Notification" u
    SET
      "status" = 'SENDING',
      "attempts" = "attempts" + 1,
      "lockedAt" = NOW(),
      "updatedAt" = NOW()
    FROM candidate
    WHERE u."id" = candidate."id"
    RETURNING u.*;
  `;
      return rows[0] ?? null;
    } catch (err) {
      console.error(err);
      throw new Error(err);
    }
  }

  async sendNext() {
    const claimed = await this.claimNextPerTenant();
    if (!claimed) return null;

    // Extra safety: if expired, drop (claim query already filters, but keep this guard)
    if (
      claimed.expiresAt &&
      new Date(claimed.expiresAt).getTime() <= Date.now()
    ) {
      const updated = await this.prisma.notification.update({
        where: { id: claimed.id },
        data: {
          status: 'DROPPED',
          lockedAt: null,
          nextAttemptAt: null,
          lastError: 'Dropped: expired before send',
        },
      });

      return { notificationId: updated.id, status: updated.status };
    }

    try {
      const { providerMessageId } = await this.mailerSend.sendTemplateEmail({
        toEmail: claimed.toEmail,
        templateId: claimed.templateId,
        variables: claimed.variables as any,
      });

      const updated = await this.prisma.notification.update({
        where: { id: claimed.id },
        data: {
          status: 'SENT',
          provider: 'mailersend',
          providerMessageId,
          sentAt: new Date(),
          lastError: null,
          lockedAt: null,
          nextAttemptAt: null,
        },
      });

      return {
        notificationId: updated.id,
        status: updated.status,
        providerMessageId,
      };
    } catch (e: any) {
      const errorMsg = String(e?.message ?? e);

      // attempts is already incremented at claim time
      const attemptsNow: number = claimed.attempts;

      // If max attempts reached => terminal FAILED
      if (attemptsNow >= this.MAX_ATTEMPTS) {
        const updated = await this.prisma.notification.update({
          where: { id: claimed.id },
          data: {
            status: 'FAILED',
            lastError: errorMsg,
            lockedAt: null,
            nextAttemptAt: null,
          },
        });

        return {
          notificationId: updated.id,
          status: updated.status,
          error: errorMsg,
          attempts: updated.attempts,
        };
      }

      // Otherwise schedule retry
      const nextAttemptAt = this.computeNextAttemptAt(attemptsNow);

      const updated = await this.prisma.notification.update({
        where: { id: claimed.id },
        data: {
          status: 'ACCEPTED',
          lastError: errorMsg,
          lockedAt: null,
          nextAttemptAt,
        },
      });

      return {
        notificationId: updated.id,
        status: 'RETRY_SCHEDULED',
        error: errorMsg,
        attempts: updated.attempts,
        nextAttemptAt: updated.nextAttemptAt,
      };
    }
  }

  async recoverStuckSending() {
    const result = await this.prisma.notification.updateMany({
      where: {
        status: 'SENDING',
        lockedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: {
        status: 'ACCEPTED',
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + 30_000), // small delay to avoid hot-loop
      },
    });

    return { recovered: result.count };
  }

  private sha256Json(input: unknown): string {
    const json = JSON.stringify(input);
    return createHash('sha256').update(json).digest('hex');
  }

  // Recursively sorts object keys so JSON stringify is stable
  private sortObjectDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => this.sortObjectDeep(v));
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const out: Record<string, unknown> = {};
      for (const k of sortedKeys) out[k] = this.sortObjectDeep(obj[k]);
      return out;
    }
    return value;
  }

  private readonly MAX_ATTEMPTS = 5;

  // attemptIndex: 1-based (because you increment attempts on claim)
  private retryDelayMs(attemptIndex: number): number {
    const delays = [10_000, 30_000, 120_000, 600_000, 1_800_000]; // 10s, 30s, 2m, 10m, 30m
    const idx = Math.min(Math.max(attemptIndex, 1), delays.length) - 1;
    return delays[idx];
  }

  private withJitter(baseMs: number, jitterRatio = 0.2): number {
    const delta = baseMs * jitterRatio;
    const min = baseMs - delta;
    const max = baseMs + delta;
    return Math.max(0, Math.floor(min + Math.random() * (max - min)));
  }

  private computeNextAttemptAt(attemptIndex: number): Date {
    const base = this.retryDelayMs(attemptIndex);
    const ms = this.withJitter(base, 0.2);
    return new Date(Date.now() + ms);
  }
}
