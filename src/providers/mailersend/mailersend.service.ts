import { Injectable } from '@nestjs/common';

type MailerSendSendResult = {
  providerMessageId: string | null;
};

@Injectable()
export class MailerSendService {
  private readonly apiKey = process.env.MAILERSEND_API_KEY!;
  private readonly fromEmail = process.env.MAILERSEND_FROM_EMAIL!;
  private readonly fromName = process.env.MAILERSEND_FROM_NAME!;

  async sendTemplateEmail(params: {
    toEmail: string;
    templateId: string;
    variables: Record<string, unknown>;
  }): Promise<MailerSendSendResult> {
    if (!this.apiKey || !this.fromEmail || !this.fromName) {
      throw new Error('MAILERSEND_* env vars are not set');
    }

    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: this.fromEmail, name: this.fromName },
        to: [{ email: params.toEmail }],
        template_id: params.templateId,
        subject: 'Your OTP code',
        personalization: [
          {
            email: params.toEmail,
            data: params.variables,
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `MailerSend error: ${res.status} ${res.statusText} ${text}`,
      );
    }

    // MailerSend typically returns message id in headers
    const providerMessageId =
      res.headers.get('x-message-id') || res.headers.get('X-Message-Id');

    return { providerMessageId };
  }
}
