-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('P0', 'P1', 'P2');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('ACCEPTED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "priority" "NotificationPriority" NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "templateId" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'ACCEPTED',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_tenantId_createdAt_idx" ON "Notification"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_priority_status_idx" ON "Notification"("priority", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_idempotencyKey_key" ON "Notification"("tenantId", "idempotencyKey");
