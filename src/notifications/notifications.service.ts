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
    console.log('i am triggered');
    try {
      const rows = await this.prisma.$queryRaw<any[]>`
    WITH candidate_tenant AS (
      SELECT "tenantId"
      FROM "Notification"
      WHERE "status" = 'ACCEPTED'
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
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
      "updatedAt" = NOW()
    FROM candidate
    WHERE u."id" = candidate."id"
    RETURNING u.*;
  `;
      console.log('returned rows:', rows);
      return rows[0] ?? null;
    } catch (err) {
      console.error(err);
      throw new Error(err);
    }
  }

  async sendNext() {
    const claimed = await this.claimNextPerTenant();
    if (!claimed) return null;

    try {
      const { providerMessageId } = await this.mailerSend.sendTemplateEmail({
        toEmail: claimed.toEmail,
        templateId: claimed.templateId,
        variables: claimed.variables as any, // Prisma returns JSON; this is fine for sending
      });

      const updated = await this.prisma.notification.update({
        where: { id: claimed.id },
        data: {
          status: 'SENT',
          provider: 'mailersend',
          providerMessageId,
          sentAt: new Date(),
          lastError: null,
        },
      });

      return {
        notificationId: updated.id,
        status: updated.status,
        providerMessageId,
      };
    } catch (e: any) {
      await this.prisma.notification.update({
        where: { id: claimed.id },
        data: {
          status: 'FAILED',
          lastError: String(e?.message ?? e),
        },
      });

      return {
        notificationId: claimed.id,
        status: 'FAILED',
        error: String(e?.message ?? e),
      };
    }
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
}
