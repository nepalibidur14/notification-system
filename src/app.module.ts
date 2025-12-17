import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { NotificationsController } from './notifications/notifications.controller.js';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
