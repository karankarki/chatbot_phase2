import { Injectable, Logger } from '@nestjs/common';
import { CrmClient } from '../crm/crm.client';
import { SessionService } from '../session/session.service';
import { getMobileRule } from '../common/mobile-rules';

@Injectable()
export class ToolRegistry {
  private readonly log = new Logger(ToolRegistry.name);

  constructor(
    private readonly crm: CrmClient,
    private readonly sessions: SessionService,
  ) {}

  async dispatch(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    this.log.log(`[${sessionId}] tool=${name} input=${JSON.stringify(input)}`);
    switch (name) {
      case 'lookup_customer':       return this.lookupCustomer(sessionId, input);
      case 'get_ticket_summary':    return this.getTicketSummary(sessionId, input);
      case 'create_ticket':         return this.createTicket(sessionId, input);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ─── Lookup customer ────────────────────────────────────────────────────────

  /**
   * Strip country code / leading-zero prefix and return the local number digits.
   * Uses the session's detected country to determine which dial code to strip.
   */
  private normalizeMobile(raw: string, country?: string): string {
    const digits = String(raw ?? '').replace(/\D+/g, '');
    const rule = getMobileRule(country);
    // Strip country dial code if present
    if (rule.dialCode && digits.startsWith(rule.dialCode)) {
      const local = digits.slice(rule.dialCode.length);
      if (local.length >= rule.minLength && local.length <= rule.maxLength) return local;
    }
    // Strip leading 0 (common trunk prefix in many countries)
    if (digits.startsWith('0')) {
      const local = digits.slice(1);
      if (local.length >= rule.minLength && local.length <= rule.maxLength) return local;
    }
    return digits;
  }

  private async lookupCustomer(sessionId: string, input: Record<string, unknown>) {
    // Short-circuit: charger already confirmed this session — no need to re-lookup.
    const existing = this.sessions.get(sessionId).slots;
    if (existing.chargerSerial) {
      return {
        found: true,
        alreadyConfirmed: true,
        customerName: existing.customerName,
        chargerSerial: existing.chargerSerial,
        warrantyStatus: existing.warrantyStatus,
        warrantyEndDate: existing.warrantyEndDate,
        note: 'Charger already confirmed in this session. Do not call this tool again.',
      };
    }

    let serial = (input.serialNumber as string | undefined)?.trim();
    const rawIdentifier = String(input.mobile ?? '').trim();

    // If the LLM mistakenly put an alphanumeric serial in the mobile field, catch it here.
    if (!serial && /[a-zA-Z]/.test(rawIdentifier)) {
      serial = rawIdentifier;
    }

    // Validate mobile before hitting the CRM
    if (!serial) {
      const country = this.sessions.get(sessionId).slots.country;
      const rule = getMobileRule(country);
      const mobile = this.normalizeMobile(rawIdentifier, country);
      const lengthDesc = rule.minLength === rule.maxLength
        ? `${rule.minLength}-digit`
        : `${rule.minLength}–${rule.maxLength}-digit`;
      if (mobile.length < rule.minLength || mobile.length > rule.maxLength) {
        return { found: false, error: `Invalid mobile number — please ask the customer to re-enter a valid ${lengthDesc} mobile number.` };
      }
    }

    // Validate serial length before CRM call
    if (serial && serial.length !== 15) {
      return {
        found: false,
        error: `That charger serial number doesn't look right — it should be exactly 15 characters, but "${serial}" has ${serial.length}. Please ask the customer to check the sticker on the back or side of the charger.`,
      };
    }

    const country = this.sessions.get(sessionId).slots.country;
    const res = serial
      ? await this.crm.lookupBySerial(serial)
      : await this.crm.lookupByMobile(this.normalizeMobile(rawIdentifier, country));

    if (res.serviceError) {
      // Save mobile even on error so inputHint flips to 'serial' (bot will ask for serial next)
      if (!serial) this.sessions.updateSlots(sessionId, { mobile: this.normalizeMobile(rawIdentifier, country) });
      return {
        found: false,
        serviceUnavailable: true,
        message: res.serviceErrorMessage,
      };
    }

    if (!res.found) {
      // Save mobile so inputHint flips to 'serial' — bot will ask for serial number next
      if (!serial) this.sessions.updateSlots(sessionId, { mobile: this.normalizeMobile(rawIdentifier, country) });
      return {
        found: false,
        message: serial
          ? 'This serial number is not registered with us. Please ask the customer to re-check the sticker on the charger — it is exactly 15 characters.'
          : 'This mobile number is not registered with us. Please ask the customer to re-enter their correct number, or ask for the serial number on the sticker on their charger.',
      };
    }

    // CRM may return no name for B2B/fleet accounts; fall back to what the
    // customer typed at Stage 1 (first user message in transcript is their name).
    let customerName = res.customerName;
    if (!customerName) {
      const s = this.sessions.get(sessionId);
      const firstUser = s.transcript.find((m) => m.role === 'user');
      const candidate = (firstUser?.content ?? '').trim();
      // Accept if it looks like a personal name: short, no long digit run
      if (candidate.length > 0 && candidate.length <= 40 && !/\d{6,}/.test(candidate)) {
        customerName = candidate.charAt(0).toUpperCase() + candidate.slice(1);
      }
    }

    this.sessions.updateSlots(sessionId, {
      customerId: res.customerId,
      customerName,
      mobile: !serial
        ? this.normalizeMobile(rawIdentifier, country)
        : (res.contactNumber ? this.normalizeMobile(res.contactNumber, country) : undefined),
      circle: res.circle,
      chargers: res.chargers,
      chargerSerial: res.autoSelectedSerial,
      chargerModel: res.autoSelectedSerial
        ? this.inferModel(res.chargers[0]?.description ?? '')
        : undefined,
      warrantyStatus: res.autoSelectedSerial ? res.chargers[0]?.warrantyStatus : undefined,
      warrantyEndDate: res.autoSelectedSerial ? res.chargers[0]?.warrantyEndDate : undefined,
    });

    // Limit charger list sent to LLM to avoid rate-limit on large fleets.
    // Session slots always hold the full list (used by the charger picker UI).
    const MAX_LLM_CHARGERS = 12;
    if (res.chargers.length > MAX_LLM_CHARGERS) {
      return {
        found: true,
        customerName,
        chargerCount: res.chargers.length,
        note: `Customer has ${res.chargers.length} chargers. The charger picker is shown to the customer — wait for them to select one, OR ask for the 15-character serial number from the sticker on the charger. Do NOT list chargers yourself.`,
      };
    }
    return { ...res, customerName };
  }

  // ─── Ticket summary ─────────────────────────────────────────────────────────

  private async getTicketSummary(sessionId: string, input: Record<string, unknown>) {
    const serial = String(input.serialNumber ?? '').trim();
    if (!serial) return { error: 'serialNumber is required.' };

    const res = await this.crm.getTicketSummary(serial);

    // Record charger selection + ticket history into session slots.
    // recentTickets is persisted here so it can be injected into SESSION_STATE
    // on every subsequent turn — tool results are not stored in the transcript.
    const s = this.sessions.get(sessionId);
    const charger = s.slots.chargers?.find((c) => c.serial === serial);
    this.sessions.updateSlots(sessionId, {
      chargerSerial: serial,
      chargerModel: this.inferModel(charger?.description ?? ''),
      warrantyStatus: charger?.warrantyStatus,
      warrantyEndDate: charger?.warrantyEndDate,
      hasActiveTicket: res.hasActiveTicket,
      activeTicketNo: res.activeTicketNo,
      recentTickets: res.recentTickets,
    });

    // Hide activeTicketNo from the LLM until Stage 5 (create_ticket returns it when blocking).
    // hasActiveTicket IS exposed so the LLM makes correct block/allow decisions without
    // trying to interpret raw ticket statuses itself (which leads to false positives on
    // ambiguous statuses like "Cancelled" with "Request Approved" timeline entries).
    const { activeTicketNo: _a, ...llmVisible } = res as unknown as Record<string, unknown>;
    return {
      ...llmVisible,
      // Explicit action signals — LLM must use these, never guess from memory
      can_raise_new_ticket: !res.hasActiveTicket,
      action_instruction: res.hasActiveTicket
        ? `BLOCKED: Do NOT call create_ticket. Do NOT mention the existing ticket to the customer at this point — just continue diagnosing their problem normally. Only if the customer explicitly asks to raise a new ticket should you then say: "There is already an open ticket for this charger, so we cannot raise a new one until it is resolved."`
        : `ALLOWED: You may proceed to call create_ticket. Do NOT proactively tell the customer they have no active tickets — only say that a new ticket can be raised if they ask.`,
    };
  }

  // ─── Create ticket ──────────────────────────────────────────────────────────

  private async createTicket(sessionId: string, input: Record<string, unknown>) {
    const s = this.sessions.get(sessionId);

    if (!s.slots.chargerSerial) {
      return { error: 'No charger selected — call get_ticket_summary first to confirm charger selection.' };
    }
    if (!s.slots.customerName) {
      // Last-resort fallback: extract name from transcript Stage 1
      const firstUser = s.transcript.find((m) => m.role === 'user');
      const candidate = (firstUser?.content ?? '').trim();
      if (candidate.length > 0 && candidate.length <= 40 && !/\d{6,}/.test(candidate)) {
        this.sessions.updateSlots(sessionId, {
          customerName: candidate.charAt(0).toUpperCase() + candidate.slice(1),
        });
        s.slots.customerName = candidate.charAt(0).toUpperCase() + candidate.slice(1);
      } else {
        return { error: 'Cannot raise ticket — customer name is required.' };
      }
    }

    // One-active-ticket rule: block if the selected charger already has an open ticket
    if (s.slots.hasActiveTicket && !input.force_create) {
      return {
        error: 'ACTIVE_TICKET_EXISTS',
        activeTicketNo: s.slots.activeTicketNo,
        message: `Charger already has an active ticket (${s.slots.activeTicketNo}). Cannot raise a new one while it is open.`,
      };
    }

    // Safety override: burnt/smoke in transcript forces High urgency regardless of input
    const burnt = /burnt|smoke|spark|black\s*marks?/i.test(
      s.transcript.map((m) => m.content).join(' '),
    );
    const urgency: 'High' | 'Medium' | 'Low' = burnt
      ? 'High'
      : ((input.urgency as 'High' | 'Medium' | 'Low') ?? 'Medium');

    // Build full description from gathered context + LLM input
    const descParts = [
      input.description as string | undefined,
      s.slots.ledState ? `LED: ${s.slots.ledState}` : '',
      s.slots.alarm ? `Alarm: ${s.slots.alarm}` : '',
      s.slots.stepsTried.length ? `Steps tried: ${s.slots.stepsTried.join(', ')}` : '',
      input.recommended_engineer_action ? `Recommended action: ${input.recommended_engineer_action}` : '',
    ].filter(Boolean).join('. ');

    const result = await this.crm.createTicket({
      description: descParts || 'Customer reported charger issue via SpinWise chat.',
      categoryLabel: (input.category_name as string) ?? 'General',
      subCategoryLabel: (input.sub_category_name as string) ?? 'Other',
      urgency,
      remarks: `Warranty: ${s.slots.warrantyStatus ?? 'Unknown'}. Consent: ${input.charges_consent ? 'Yes' : 'No'}.`,
      customerName: s.slots.customerName,
      mobileNumber: s.slots.mobile ?? '',
      serialNumber: s.slots.chargerSerial,
      locationState: s.slots.circle,
      attachmentUrls: (input.photos_attachments as string[] | undefined) ?? s.slots.photos,
    });

    this.sessions.updateSlots(sessionId, { ticketId: result.ticketId });
    return result;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Best-effort model inference from the charger description string. */
  private inferModel(description: string): 'Spin Air' | 'Tata/Compact' | undefined {
    const d = description.toLowerCase();
    if (d.includes('tata') || d.includes('compact')) return 'Tata/Compact';
    if (d.includes('spin air') || d.includes('spinair')) return 'Spin Air';
    return undefined;
  }
}
