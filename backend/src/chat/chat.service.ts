import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { LlmService } from '../llm/llm.service';
import { Attachment, StartSessionDto } from './dto';

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly log = new Logger(ChatService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    const nudgeMin = Number(process.env.SESSION_IDLE_NUDGE_MINUTES ?? 5);
    const closeMin = Number(process.env.SESSION_CLOSE_MINUTES ?? 10);

    setInterval(() => {
      for (const s of this.sessions.idleSessions(closeMin)) {
        this.log.log(`[${s.id}] idle ${closeMin}m — closing`);
        this.sessions.close(s.id);
      }
      for (const s of this.sessions.idleSessions(nudgeMin)) {
        // Naive idempotency: only nudge if the last assistant turn isn't already a nudge
        const last = s.transcript[s.transcript.length - 1];
        if (last?.role === 'assistant' && last.content.startsWith('Are you still there')) continue;
        this.sessions.append(s.id, {
          role: 'assistant',
          content:
            'Are you still there? I can wait — or if you have your ticket number, I can share its current status.',
        });
      }
    }, 60_000).unref();
  }

  start(dto: StartSessionDto) {
    // Build charger slots from the mobile app's prefilled serial list.
    // If only one serial, auto-select it. If multiple, store the list so the
    // charger picker UI fires on the first message exchange.
    const serials = dto.prefillChargerSerials?.filter(Boolean) ?? [];
    const chargers = serials.length > 1
      ? serials.map((s, i) => ({
          index: i + 1,
          serial: s,
          description: s,
          warrantyStatus: 'Unknown',
          isCommissioned: true,
        }))
      : undefined;
    const autoSerial = serials.length === 1 ? serials[0] : dto.prefillChargerSerial;

    const session = this.sessions.create(dto.channel, {
      customerName: dto.prefillName,
      mobile: dto.prefillMobile,
      chargerSerial: autoSerial,
      chargerModel: dto.prefillChargerModel,
      chargers,
    });

    // Tell frontend what to show immediately alongside the greeting:
    // - chargerOptions: show picker right away (multiple prefilled serials)
    // - showIssueTypes: show issue buttons right away (single charger already known)
    const chargerOptions = chargers && chargers.length > 1 ? chargers : undefined;
    const showIssueTypes = !!autoSerial && !chargerOptions;

    return { sessionId: session.id, channel: session.channel, chargerOptions, showIssueTypes };
  }

  async sendStream(
    sessionId: string,
    message: string,
    onChunk: (text: string) => void,
    attachments?: Attachment[],
  ) {
    const attachmentNote = attachments?.length
      ? ` [Attached: ${attachments.map((a) => a.name).join(', ')}]`
      : '';
    this.sessions.append(sessionId, { role: 'user', content: message + attachmentNote });

    // Capture pre-turn charger state to detect first-time selection from multi-charger list
    const sBefore = this.sessions.get(sessionId);
    const hadChargerBefore = !!sBefore.slots.chargerSerial;
    const hadMultipleChargers = (sBefore.slots.chargers?.length ?? 0) > 1;

    // If the charger picker is active and user sent a numeric index, resolve it to a serial
    // directly so the LLM receives charger_confirmed in SESSION_STATE instead of raw "2".
    if (!hadChargerBefore && hadMultipleChargers) {
      const idx = parseInt(message.trim(), 10);
      if (!isNaN(idx) && idx >= 1 && idx <= sBefore.slots.chargers!.length) {
        const picked = sBefore.slots.chargers![idx - 1];
        this.sessions.updateSlots(sessionId, {
          chargerSerial: picked.serial,
          chargerDescription: picked.description !== picked.serial ? picked.description : undefined,
          ...(picked.warrantyStatus !== 'Unknown' && { warrantyStatus: picked.warrantyStatus }),
          ...(picked.warrantyEndDate && { warrantyEndDate: picked.warrantyEndDate }),
        });
      }
    }

    const { closed } = await this.llm.respondStream(sessionId, onChunk, attachments);

    const s = this.sessions.get(sessionId);
    const chargerOptions =
      !s.slots.chargerSerial && s.slots.chargers && s.slots.chargers.length > 1
        ? s.slots.chargers
        : undefined;

    // Re-surface issue type buttons after charger selection only for in-app (Spin App) channel.
    // Web users already selected their issue type before the charger lookup, so don't show again.
    const showIssueTypes = !hadChargerBefore && !!s.slots.chargerSerial && hadMultipleChargers
      && s.channel === 'in-app';

    // Tell the frontend which input mode to enforce next.
    // If mobile is already known (pre-filled from Spin App or captured from CRM),
    // skip the turn-count gate and go straight to serial hint if needed.
    // Otherwise wait for ≥2 user turns (name exchange) before switching to mobile mode.
    const userTurnCount = s.transcript.filter((m) => m.role === 'user').length;
    const inputHint: 'mobile' | 'serial' | null = s.slots.mobile
      ? !s.slots.chargerSerial ? 'serial' : null
      : userTurnCount < 2
        ? null
        : 'mobile';

    const ticketId = s.slots.ticketId;
    return { sessionId, closed, ticketId, chargerOptions, inputHint, showIssueTypes };
  }

  history(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return { sessionId: s.id, transcript: s.transcript, slots: s.slots };
  }
}
