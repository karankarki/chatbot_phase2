import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { LlmService } from '../llm/llm.service';
import { CrmClient } from '../crm/crm.client';
import { Attachment, StartSessionDto } from './dto';

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly log = new Logger(ChatService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly llm: LlmService,
    private readonly crm: CrmClient,
  ) {}

  onModuleInit() {
    const nudgeMin = Number(process.env.SESSION_IDLE_NUDGE_MINUTES ?? 5);
    const closeMin = Number(process.env.SESSION_CLOSE_MINUTES ?? 10);

    setInterval(() => {
      for (const s of this.sessions.idleSessions(closeMin)) {
        this.log.log(`[${s.id}] idle ${closeMin}m — closing`);
        // Save incomplete conversation before closing so Spin App can resume it
        if (s.slots.mobile && s.slots.chargerSerial) {
          const msgs = s.transcript
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
          this.crm.saveChatHistory(s.slots.mobile, s.slots.chargerSerial, msgs, false).catch(() => {});
        }
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

  async start(dto: StartSessionDto) {
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

    // Fetch and restore chat history — in-app (Spin App) with single serial only.
    // Web widget never restores; multi-serial restore happens after charger selection in sendStream.
    let restoredMessages: Array<{ role: 'user' | 'bot'; text: string }> | undefined;
    if (dto.channel === 'in-app' && dto.prefillMobile && autoSerial && !chargerOptions) {
      const history = await this.crm.fetchChatHistory(dto.prefillMobile, autoSerial);
      if (history.found && !history.isClosed && history.messages?.length) {
        for (const m of history.messages) {
          this.sessions.append(session.id, {
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          });
        }
        restoredMessages = history.messages.map((m) => ({
          role: (m.role === 'assistant' ? 'bot' : 'user') as 'user' | 'bot',
          text: m.content,
        }));
        this.log.log(`[${session.id}] restored ${history.messages.length} msgs from chat history`);

        // Pre-populate ticket info so the SESSION_STATE directive doesn't tell the LLM
        // to re-announce the charger or call get_ticket_summary on the first resumed turn.
        const ticketInfo = await this.crm.getTicketSummary(autoSerial);
        this.sessions.updateSlots(session.id, {
          hasActiveTicket: ticketInfo.hasActiveTicket,
          activeTicketNo: ticketInfo.activeTicketNo,
          activeTicketStatus: ticketInfo.activeTicketStatus,
          recentTickets: ticketInfo.recentTickets,
          restored: true,
        });
      }
    }

    return { sessionId: session.id, channel: session.channel, chargerOptions, showIssueTypes, restoredMessages };
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

        // For Spin App (in-app) only: check if an open conversation exists for this mobile+serial.
        // If found, restore historical messages before the current message so the LLM resumes
        // naturally. Web-widget never restores — always starts fresh.
        if (sBefore.channel === 'in-app' && sBefore.slots.mobile) {
          const history = await this.crm.fetchChatHistory(sBefore.slots.mobile, picked.serial);
          if (history.found && !history.isClosed && history.messages?.length) {
            // Insert historical messages before the current user message in the transcript
            const s = this.sessions.get(sessionId);
            const currentMsg = s.transcript.pop()!; // temporarily remove the just-appended user msg
            for (const m of history.messages) {
              s.transcript.push({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
                ts: 0,
              });
            }
            s.transcript.push(currentMsg); // re-append current message at the end

            // Pre-populate ticket info so the LLM gets the "RESUMED" directive immediately
            const ticketInfo = await this.crm.getTicketSummary(picked.serial);
            this.sessions.updateSlots(sessionId, {
              hasActiveTicket: ticketInfo.hasActiveTicket,
              activeTicketNo: ticketInfo.activeTicketNo,
              activeTicketStatus: ticketInfo.activeTicketStatus,
              recentTickets: ticketInfo.recentTickets,
              restored: true,
            });
            this.log.log(`[${sessionId}] resumed conversation after multi-charger selection (${picked.serial})`);
          }
        }
      }
    }

    const { closed } = await this.llm.respondStream(sessionId, onChunk, attachments);

    // Persist conversation to CRM after every turn so it can be resumed if the user abandons.
    // Pass closed=true only on graceful end so fetch can tell resumable from completed.
    {
      const sSave = this.sessions.get(sessionId);
      if (sSave.slots.mobile && sSave.slots.chargerSerial) {
        const msgs = sSave.transcript
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
        this.crm.saveChatHistory(sSave.slots.mobile, sSave.slots.chargerSerial, msgs, closed).catch(() => {});
      }
    }

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
    const lastBotMsg = [...s.transcript].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const lastUserMsg = [...s.transcript].reverse().find((m) => m.role === 'user')?.content ?? '';
    const botAskingMobile = /mobile\s*(number)?|phone\s*(number)?|registered\s*number/i.test(lastBotMsg);
    const botAskingSerial = /(share|provide|enter|give|tell).*serial|(serial\s*(number)?\s*(printed|on.*sticker))|printed on.*sticker/i.test(lastBotMsg);
    const userGaveUpSerial = /don.?t\s*have|no\s*serial|without.*serial|can.?t\s*find|not.*serial|no.*serial/i.test(lastUserMsg);
    const userTurnCount = s.transcript.filter((m) => m.role === 'user').length;
    const inputHint: 'mobile' | 'serial' | null = closed ? null
      : s.slots.mobile
        ? (!s.slots.chargerSerial && botAskingSerial && !userGaveUpSerial) ? 'serial' : null
        : botAskingMobile
          ? 'mobile'
          : null;

    const showYesNo = !closed && lastBotMsg.includes('?')
      && (/\bMCB\b/i.test(lastBotMsg)
        || /burnt|black\s*mark|burn\s*mark/i.test(lastBotMsg)
        || /anything else/i.test(lastBotMsg)
        || /share.*feedback|leave.*feedback|feedback.*experience|feedback.*today/i.test(lastBotMsg));

    // Show MCB reference images when the user says they don't know what MCB is,
    // where to find it, or what it looks like.
    const userAskedAboutMcb = /\b(mcb|mccb)\b.*(what|how|where|look|find|show|appear|picture|image|identify|recogni[sz]e)|.*(what|how|where|look|find|show|appear|picture|image|don.?t know|no idea|never|identify|recogni[sz]e).*\b(mcb|mccb)\b/i.test(lastUserMsg);
    const showMcbImages = !closed && userAskedAboutMcb;

    const ticketId = s.slots.ticketId;
    const nocHandoffActive = !closed && !!s.slots.handoffRequested;
    return { sessionId, closed, ticketId, chargerOptions, inputHint, showIssueTypes, showYesNo, showMcbImages, nocHandoffActive };
  }

  // Called when the user submits a star rating after a closed session.
  // Re-saves the conversation with the rating appended so it's persisted in CRM.
  async saveRating(sessionId: string, rating: number, feedback?: string) {
    const s = this.sessions.get(sessionId);
    if (!s.slots.mobile || !s.slots.chargerSerial) return;
    const msgs = s.transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // Append rating as a synthetic record so it's stored alongside the conversation
    msgs.push({ role: 'user', content: `[RATING: ${rating}/5${feedback ? ` — ${feedback}` : ''}]` });
    await this.crm.saveChatHistory(s.slots.mobile, s.slots.chargerSerial, msgs, true).catch(() => {});
    this.log.log(`[${sessionId}] rating saved: ${rating}/5`);
  }

  // Called via sendBeacon on page/app close to persist an in-progress session.
  saveOpenChat(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s.slots.mobile || !s.slots.chargerSerial) return;
    const msgs = s.transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    this.crm.saveChatHistory(s.slots.mobile, s.slots.chargerSerial, msgs, false).catch(() => {});
    this.log.log(`[${sessionId}] open-chat saved on page close`);
  }

  history(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return { sessionId: s.id, transcript: s.transcript, slots: s.slots };
  }
}
