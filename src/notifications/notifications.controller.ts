import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';

@Controller()
export class NotificationsController {
    constructor(private readonly notificationsService:NotificationsService) {}

    @Post('/v1/notifications')
    @HttpCode(HttpStatus.ACCEPTED)
    async create(@Body() dto:CreateNotificationDto) {
        return this.notificationsService.create(dto)
    }
}
