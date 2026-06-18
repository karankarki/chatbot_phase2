import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface TicketFailureMailPayload {
  customerName?: string;
  mobile?: string;
  serialNumber?: string;
  chargerDescription?: string;
  warrantyStatus?: string;
  issueDescription: string;
  ledState?: string;
  alarm?: string;
  stepsTried: string[];
  channel: string;
  sessionId: string;
  failureReason?: string;
}

@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const host = process.env.MAIL_HOST;
    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.MAIL_PORT ?? 587),
        secure: false,
        auth: { user, pass },
      });
      this.log.log(`Mail service ready (${host})`);
    } else {
      this.log.warn('MAIL_HOST / MAIL_USER / MAIL_PASS not set — email fallback disabled. Set them in .env to enable.');
    }
  }

  async sendTicketFailureMail(payload: TicketFailureMailPayload): Promise<boolean> {
    const to = process.env.MAIL_SUPPORT_TO ?? 'evsupport@exicom.in';
    const from = process.env.MAIL_FROM ?? 'spinwise@exicom.in';

    const subject = `[SpinWise] Ticket creation failed — ${payload.customerName ?? 'Unknown'} | ${payload.serialNumber ?? 'No serial'}`;

    const html = `
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px">
<h2 style="color:#e05c00">SpinWise — Ticket Creation Failed</h2>
<p>A customer reached out via SpinWise chat but the ticket could not be raised automatically.
Please follow up at the contact details below.</p>

<table style="width:100%;border-collapse:collapse;margin:16px 0">
  <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold;width:40%">Customer Name</td><td style="padding:8px">${payload.customerName ?? '—'}</td></tr>
  <tr><td style="padding:8px;font-weight:bold">Mobile</td><td style="padding:8px">${payload.mobile ?? '—'}</td></tr>
  <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Charger Serial</td><td style="padding:8px">${payload.serialNumber ?? '—'}</td></tr>
  <tr><td style="padding:8px;font-weight:bold">Charger Model</td><td style="padding:8px">${payload.chargerDescription ?? '—'}</td></tr>
  <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Warranty</td><td style="padding:8px">${payload.warrantyStatus ?? '—'}</td></tr>
  <tr><td style="padding:8px;font-weight:bold">Channel</td><td style="padding:8px">${payload.channel}</td></tr>
  <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Session ID</td><td style="padding:8px;font-size:12px">${payload.sessionId}</td></tr>
</table>

<h3 style="color:#e05c00">Issue Details</h3>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
  <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold;width:40%">Description</td><td style="padding:8px">${payload.issueDescription}</td></tr>
  ${payload.ledState ? `<tr><td style="padding:8px;font-weight:bold">LED State</td><td style="padding:8px">${payload.ledState}</td></tr>` : ''}
  ${payload.alarm ? `<tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Alarm</td><td style="padding:8px">${payload.alarm}</td></tr>` : ''}
  ${payload.stepsTried.length ? `<tr><td style="padding:8px;font-weight:bold">Steps Already Tried</td><td style="padding:8px">${payload.stepsTried.join('<br>')}</td></tr>` : ''}
  ${payload.failureReason ? `<tr style="background:#fff3cd"><td style="padding:8px;font-weight:bold">Failure Reason</td><td style="padding:8px;color:#856404">${payload.failureReason}</td></tr>` : ''}
</table>

<p style="color:#888;font-size:12px">This email was generated automatically by SpinWise. Please respond to the customer within 24 hours.</p>
</body></html>`;

    if (!this.transporter) {
      // Log to console so dev can see it even without SMTP configured
      this.log.warn(`[EMAIL FALLBACK — not sent, SMTP not configured]\nTo: ${to}\nSubject: ${subject}\nCustomer: ${payload.customerName} | ${payload.mobile} | ${payload.serialNumber}\nIssue: ${payload.issueDescription}`);
      return false;
    }

    try {
      await this.transporter.sendMail({ from, to, subject, html });
      this.log.log(`Ticket-failure email sent to ${to} for session ${payload.sessionId}`);
      return true;
    } catch (err) {
      this.log.error(`Failed to send ticket-failure email: ${(err as Error).message}`);
      return false;
    }
  }
}
