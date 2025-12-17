import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';
import { createHash } from 'crypto';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

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
