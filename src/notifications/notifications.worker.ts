import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { Interval } from '@nestjs/schedule';

@Injectable()
export class NotificationWorker {
  private readonly logger = new Logger(NotificationWorker.name);
  private running = false;

  private readonly enabled = process.env.NOTIF_WORKER_ENABLED !== 'false';
  private readonly batchsize = Number(
    process.env.NOTIF_WORKER_BATCH_SIZE ?? 10,
  );
  private readonly intervalMs = Number(
    process.env.NOTIF_WORKER_INTERVAL_MS ?? 500,
  );

  constructor(private readonly notifications: NotificationsService) {}

  @Interval(Number(process.env.NOTIF_WORKER_INTERVAL_MS ?? 500))
  async tick() {
    this.logger.log('Scheduler running!!')
    if (!this.enabled) return;
    if (this.running) return;

    this.running = true;
    try {
      for (let i = 0; i < this.batchsize; i++) {
        const result = await this.notifications.sendNext();
        if (!result) break;
      }
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.running = false;
    }
  }
}
