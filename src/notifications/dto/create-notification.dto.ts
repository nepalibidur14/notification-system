import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Prisma } from '@prisma/client';

class NotificationRecipientDto {
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class CreateNotificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  eventType!: string;

  @IsIn(['P0', 'P1', 'P2'])
  priority!: 'P0' | 'P1' | 'P2';

  @ValidateNested()
  @Type(() => NotificationRecipientDto)
  to!: NotificationRecipientDto;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  templateId!: string;

  @IsObject()
  variables!: Prisma.InputJsonValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60 * 60 * 24 * 7) // max 7 days for now
  ttlSeconds?: number;
}
