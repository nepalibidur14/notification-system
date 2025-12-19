import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { MailerSendModule } from '../providers/mailersend/mailersend.module.js';
import { NotificationWorker } from './notifications.worker.js';

@Module({
  imports: [MailerSendModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationWorker],
})
export class NotificationsModule {}
