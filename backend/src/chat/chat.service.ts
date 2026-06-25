import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as geoip from 'geoip-lite';
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

  async start(dto: StartSessionDto, clientIp?: string) {
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

    const country = clientIp ? (geoip.lookup(clientIp)?.country ?? undefined) : undefined;

    const session = this.sessions.create(dto.channel, {
      country,
      customerName: dto.prefillName,
      mobile: dto.prefillMobile,
      chargerSerial: autoSerial,
      chargerModel: dto.prefillChargerModel,
      chargers,
      chargerModels: dto.prefillChargerModels,
    });

    // Tell frontend what to show immediately alongside the greeting:
    // - chargerOptions: show picker right away (multiple prefilled serials)
    // - showIssueTypes: show issue buttons right away (single charger already known)
    const chargerOptions = chargers && chargers.length > 1 ? chargers : undefined;
    const showIssueTypes = !!autoSerial && !chargerOptions;

    // Fetch chat history for in-app (Spin App) single-serial sessions.
    // If an open (non-ended) conversation exists, store it as pendingHistory and return
    // hasPreviousChat:true so the frontend can show "Continue / Start new" buttons.
    // The history is NOT loaded into the transcript until the user chooses "Continue".
    let hasPreviousChat = false;
    if (dto.channel === 'in-app' && dto.prefillMobile && autoSerial && !chargerOptions) {
      const history = await this.crm.fetchChatHistory(dto.prefillMobile, autoSerial);
      if (history.found && !history.isClosed && history.messages?.length) {
        this.sessions.updateSlots(session.id, { pendingHistory: history.messages });
        hasPreviousChat = true;
        this.log.log(`[${session.id}] found ${history.messages.length} pending msgs — waiting for user choice`);
      }
    }

    return { sessionId: session.id, channel: session.channel, chargerOptions, showIssueTypes, hasPreviousChat, country: country ?? null };
  }

  updateCountry(sessionId: string, country: string) {
    this.sessions.updateSlots(sessionId, { country: country.toUpperCase() });
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
    let pickedSerial: string | undefined;
    if (!hadChargerBefore && hadMultipleChargers) {
      const idx = parseInt(message.trim(), 10);
      if (!isNaN(idx) && idx >= 1 && idx <= sBefore.slots.chargers!.length) {
        const picked = sBefore.slots.chargers![idx - 1];
        pickedSerial = picked.serial;
        this.sessions.updateSlots(sessionId, {
          chargerSerial: picked.serial,
          chargerDescription: picked.description !== picked.serial ? picked.description : undefined,
          ...(picked.warrantyStatus !== 'Unknown' && { warrantyStatus: picked.warrantyStatus }),
          ...(picked.warrantyEndDate && { warrantyEndDate: picked.warrantyEndDate }),
        });

        // For Spin App (in-app) only: check if an open conversation exists for this mobile+serial.
        // If found, store as pendingHistory so the user can choose Continue or Start New.
        // Web-widget never has previous chat — always starts fresh.
        if (sBefore.channel === 'in-app' && sBefore.slots.mobile) {
          const [history, ticketInfo] = await Promise.all([
            this.crm.fetchChatHistory(sBefore.slots.mobile, picked.serial),
            this.crm.getTicketSummary(picked.serial),
          ]);
          if (history.found && !history.isClosed && history.messages?.length) {
            // Store as pendingHistory — user will choose Continue or Start New (not silent restore)
            this.sessions.updateSlots(sessionId, {
              hasActiveTicket: ticketInfo.hasActiveTicket,
              activeTicketNo: ticketInfo.activeTicketNo,
              activeTicketStatus: ticketInfo.activeTicketStatus,
              recentTickets: ticketInfo.recentTickets,
              pendingHistory: history.messages,
            });
            this.log.log(`[${sessionId}] found pending history after multi-charger selection (${picked.serial}) — prompting user`);
          } else {
            this.sessions.updateSlots(sessionId, {
              hasActiveTicket: ticketInfo.hasActiveTicket,
              activeTicketNo: ticketInfo.activeTicketNo,
              activeTicketStatus: ticketInfo.activeTicketStatus,
              recentTickets: ticketInfo.recentTickets,
            });
          }
        }
      }
    }

    // Replace the raw picker index (e.g. "2") in the transcript with a semantic message so
    // the LLM never sees a bare number as a user utterance and gets confused about what "7" means.
    if (pickedSerial) {
      const s = this.sessions.get(sessionId);
      const lastMsg = s.transcript[s.transcript.length - 1];
      if (lastMsg?.role === 'user') {
        lastMsg.content = `[User selected charger ${pickedSerial} from the charger list]`;
      }
    }

    // If pending history was found right after charger selection, skip the LLM and ask
    // the user to choose Continue or Start New instead of greeting fresh.
    const sForPick = this.sessions.get(sessionId);
    const pendingHistoryAfterPick = !hadChargerBefore && hadMultipleChargers
      && sBefore.channel === 'in-app'
      && !!sForPick.slots.pendingHistory?.length;

    let closed = false;
    if (pendingHistoryAfterPick) {
      const cannedReply = 'I found an unfinished conversation for this charger. Would you like to continue where you left off, or start a fresh conversation?';
      onChunk(cannedReply);
      this.sessions.append(sessionId, { role: 'assistant', content: cannedReply });
    } else {
      ({ closed } = await this.llm.respondStream(sessionId, onChunk, attachments));
    }

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
    // Don't show if user needs to choose Continue vs Start New first.
    const hasPreviousChat = pendingHistoryAfterPick;
    const showIssueTypes = !hadChargerBefore && !!s.slots.chargerSerial && hadMultipleChargers
      && s.channel === 'in-app' && !s.slots.restored && !hasPreviousChat;

    // Tell the frontend which input mode to enforce next.
    const lastBotMsg = [...s.transcript].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const lastUserMsg = [...s.transcript].reverse().find((m) => m.role === 'user')?.content ?? '';
    // Only trigger when the bot is explicitly requesting the number as input,
    // not when it merely mentions "mobile number" in guidance text.
    const botAskingMobile = /\b(share|provide|enter|give|tell\s+me)\s+(your\s+)?(mobile|phone|registered)\s*(number)?/i.test(lastBotMsg)
      || /\byour\s+registered\s+mobile\s+number\b.*\?/i.test(lastBotMsg);
    const botAskingSerial = /(share|provide|enter|give|tell).*serial|(serial\s*(number)?\s*(printed|on.*sticker))|printed on.*sticker/i.test(lastBotMsg);
    const userGaveUpSerial = /don.?t\s*have|no\s*serial|without.*serial|can.?t\s*find|not.*serial|no.*serial/i.test(lastUserMsg);
    const userTurnCount = s.transcript.filter((m) => m.role === 'user').length;
    const inputHint: 'mobile' | 'serial' | null = closed ? null
      : s.slots.mobile
        ? (!s.slots.chargerSerial && botAskingSerial && !userGaveUpSerial) ? 'serial' : null
        : botAskingMobile
          ? 'mobile'
          : null;

    // Split into sentences and find those that end with '?' — only check those
    // for Yes/No keywords so incidental mentions (e.g. "no burnt marks, can I have your name?")
    // don't incorrectly trigger the buttons.
    const questionSentences = lastBotMsg
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trimEnd().endsWith('?'))
      .join(' ');
    const showYesNo = !closed && questionSentences.length > 0
      && (/\bMCB\b/i.test(questionSentences)
        || /burnt|black\s*mark|burn\s*mark/i.test(questionSentences)
        || /anything else/i.test(questionSentences)
        || /share.*feedback|leave.*feedback|feedback.*experience|feedback.*today/i.test(questionSentences));

    // Show MCB reference images when the user says they don't know what MCB is,
    // where to find it, or what it looks like.
    const userAskedAboutMcb = /\b(mcb|mccb)\b.*(what|how|where|look|find|show|appear|picture|image|identify|recogni[sz]e)|.*(what|how|where|look|find|show|appear|picture|image|don.?t know|no idea|never|identify|recogni[sz]e).*\b(mcb|mccb)\b/i.test(lastUserMsg);
    const showMcbImages = !closed && userAskedAboutMcb;

    // Show LED pattern picker only when the bot is explicitly asking the customer to describe their LED.
    // Must be a question — not a statement describing a fault or explaining LED behaviour.
    const botAskingAboutLed = /what colou?r is the (led|light)|colou?r.*\b(led|light)\b.*pattern|(led|light).*colou?r.*(solid|blink)|is (it|the led|the light) solid or blink/i.test(lastBotMsg);
    const currentSerial = s.slots.chargerSerial;
    const ledChargerModel = currentSerial ? s.slots.chargerModels?.[currentSerial] : undefined;
    const showLedPicker: 'old' | 'new' | null =
      !closed && s.channel === 'in-app' && botAskingAboutLed && ledChargerModel
        ? ledChargerModel
        : null;

    const ticketId = s.slots.ticketId;
    return { sessionId, closed, ticketId, chargerOptions, inputHint, showIssueTypes, showYesNo, showMcbImages, showLedPicker, hasPreviousChat };
  }

  // Called when the user explicitly chooses "Continue previous chat".
  // Moves pendingHistory into the live transcript and pre-populates ticket slots.
  async resumeSession(sessionId: string): Promise<{ messages: Array<{ role: 'user' | 'bot'; text: string }> }> {
    const s = this.sessions.get(sessionId);
    const pending = s.slots.pendingHistory;
    if (!pending?.length) return { messages: [] };

    for (const m of pending) {
      this.sessions.append(sessionId, {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }

    if (s.slots.chargerSerial) {
      const ticketInfo = await this.crm.getTicketSummary(s.slots.chargerSerial);
      this.sessions.updateSlots(sessionId, {
        hasActiveTicket: ticketInfo.hasActiveTicket,
        activeTicketNo: ticketInfo.activeTicketNo,
        activeTicketStatus: ticketInfo.activeTicketStatus,
        recentTickets: ticketInfo.recentTickets,
        restored: true,
        pendingHistory: [],
      });
    } else {
      this.sessions.updateSlots(sessionId, { restored: true, pendingHistory: [] });
    }

    this.log.log(`[${sessionId}] user chose Continue — restored ${pending.length} msgs`);
    return {
      messages: pending.map((m) => ({
        role: (m.role === 'assistant' ? 'bot' : 'user') as 'user' | 'bot',
        text: m.content,
      })),
    };
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
