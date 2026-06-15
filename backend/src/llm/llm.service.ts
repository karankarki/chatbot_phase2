import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { SPINWISE_SYSTEM_PROMPT } from '../chat/prompt';
import { TOOL_SCHEMAS } from './tool-schemas';
import { ToolRegistry } from './tools.registry';
import { ChatMessage, ChatSession, SessionService } from '../session/session.service';
import { Attachment } from '../chat/dto';
import { CrmClient } from '../crm/crm.client';

@Injectable()
export class LlmService implements OnModuleInit {
  private static readonly MAX_TOOL_ITERATIONS = 8;

  private readonly log = new Logger(LlmService.name);
  private client!: Anthropic;
  private model!: string;
  private maxTokens!: number;

  constructor(
    private readonly tools: ToolRegistry,
    private readonly sessions: SessionService,
    private readonly crm: CrmClient,
  ) {}

  onModuleInit() {
    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey) {
      this.log.warn('LLM_API_KEY not set — chat will return a stub response.');
    }
    this.client = new Anthropic({ apiKey: apiKey ?? 'missing-key' });
    this.model = process.env.LLM_MODEL ?? 'claude-haiku-4-5-20251001';
    this.maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 800);
  }

  /** Build the shared request params (system prompt + tools + messages). */
  private async buildRequestParams(sessionId: string, attachments?: Attachment[]) {
    const categories = await this.crm.getCategoriesForDisplay();
    const systemPrompt = SPINWISE_SYSTEM_PROMPT + this.buildCategoryBlock(categories);
    const session = this.sessions.get(sessionId);
    const messages = this.toAnthropicMessages(session.transcript, session.slots);
    if (attachments?.length) {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        last.content = this.buildMultiModalContent(last.content as string, attachments);
      }
    }
    const system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as unknown as Anthropic.TextBlockParam[];
    const tools = [
      ...TOOL_SCHEMAS.slice(0, -1),
      { ...TOOL_SCHEMAS[TOOL_SCHEMAS.length - 1], cache_control: { type: 'ephemeral' } },
    ] as Anthropic.Tool[];
    return { system, tools, messages };
  }

  /** Execute tool_use blocks and append results to the messages array in-place. */
  private async runTools(sessionId: string, response: Anthropic.Message, messages: Anthropic.MessageParam[]) {
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      let result: unknown;
      try {
        result = await this.tools.dispatch(sessionId, tu.name, tu.input as Record<string, unknown>);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  /** Finalize the text response: strip [END], close session if needed, append to transcript. */
  private finalizeText(sessionId: string, raw: string): { text: string; closed: boolean } {
    let text = raw.trim();
    let closed = false;
    if (text.includes('[END]')) {
      text = text.replace(/\[END\]\s*$/m, '').trimEnd();
      closed = true;
      this.sessions.close(sessionId);
    }
    this.sessions.append(sessionId, { role: 'assistant', content: text });
    return { text, closed };
  }

  async respond(sessionId: string, attachments?: Attachment[]): Promise<string> {
    if (!process.env.LLM_API_KEY) return this.stubReply(sessionId);
    const { system, tools, messages } = await this.buildRequestParams(sessionId, attachments);

    for (let iter = 0; iter < LlmService.MAX_TOOL_ITERATIONS; iter++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({ model: this.model, max_tokens: this.maxTokens, system, tools, messages });
      } catch (e) {
        this.log.error(`Anthropic API error: ${(e as Error).message}`);
        const errReply = 'I am unable to connect to the AI service right now. Please try again in a moment.';
        this.sessions.append(sessionId, { role: 'assistant', content: errReply });
        return errReply;
      }
      if (response.stop_reason === 'tool_use') { await this.runTools(sessionId, response, messages); continue; }
      const raw = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
      return this.finalizeText(sessionId, raw).text;
    }

    const fallback = 'I am having trouble completing that step. Would you like me to raise a complaint and have an engineer follow up?';
    this.sessions.append(sessionId, { role: 'assistant', content: fallback });
    return fallback;
  }

  /** Streaming variant — pipes text tokens to onChunk as they arrive. */
  async respondStream(
    sessionId: string,
    onChunk: (text: string) => void,
    attachments?: Attachment[],
  ): Promise<{ text: string; closed: boolean }> {
    if (!process.env.LLM_API_KEY) {
      const reply = this.stubReply(sessionId);
      onChunk(reply);
      return { text: reply, closed: false };
    }
    const { system, tools, messages } = await this.buildRequestParams(sessionId, attachments);

    for (let iter = 0; iter < LlmService.MAX_TOOL_ITERATIONS; iter++) {
      const chunks: string[] = [];
      let response: Anthropic.Message;
      try {
        const stream = this.client.messages.stream({ model: this.model, max_tokens: this.maxTokens, system, tools, messages });
        // Forward text deltas to the caller as they arrive.
        // Tool-use iterations produce no text, so onChunk is effectively a no-op there.
        stream.on('text', (delta: string) => { onChunk(delta); chunks.push(delta); });
        response = await stream.finalMessage();
      } catch (e) {
        this.log.error(`Anthropic stream error: ${(e as Error).message}`);
        const errReply = 'I am unable to connect to the AI service right now. Please try again in a moment.';
        onChunk(errReply);
        this.sessions.append(sessionId, { role: 'assistant', content: errReply });
        return { text: errReply, closed: false };
      }
      if (response.stop_reason === 'tool_use') { await this.runTools(sessionId, response, messages); continue; }
      return this.finalizeText(sessionId, chunks.join(''));
    }

    const fallback = 'I am having trouble completing that step. Would you like me to raise a complaint and have an engineer follow up?';
    onChunk(fallback);
    this.sessions.append(sessionId, { role: 'assistant', content: fallback });
    return { text: fallback, closed: false };
  }

  /**
   * Build a multi-block content array for a user message that includes file attachments.
   * Images → image blocks (vision). PDFs → document blocks. Videos → text note (unsupported by Claude).
   */
  /**
   * Build a multi-block content array for a user message that includes file attachments.
   * Uses the SDK's Param types (input), not ContentBlock (output/response).
   */
  private buildMultiModalContent(
    text: string,
    attachments: Attachment[],
  ): Array<Anthropic.Messages.ImageBlockParam | Anthropic.Messages.TextBlockParam> {
    const blocks: Array<Anthropic.Messages.ImageBlockParam | Anthropic.Messages.TextBlockParam> = [];

    for (const att of attachments) {
      if (att.type === 'image') {
        const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        const mediaType = supported.includes(att.mediaType)
          ? (att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
          : 'image/jpeg';
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: att.data },
        });
      } else if (att.type === 'pdf') {
        // PDFs sent as text note — model reads PDF content injected by the browser if supported
        blocks.push({
          type: 'text',
          text: `[PDF document attached: "${att.name}". Analyze its content and extract any relevant information for troubleshooting.]`,
        });
      } else if (att.type === 'video') {
        blocks.push({
          type: 'text',
          text: `[Video file attached: "${att.name}". You cannot analyze video — ask the customer to describe what they see or provide a screenshot.]`,
        });
      }
    }

    blocks.push({ type: 'text', text });
    return blocks;
  }

  private toAnthropicMessages(
    transcript: ChatMessage[],
    slots: ChatSession['slots'],
  ): Anthropic.MessageParam[] {
    const msgs = transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Sliding window: once > 12 messages, drop the oldest 4 pairs (8 messages).
    const TRIM_AFTER = 12;
    const DROP = 8;
    const trimmed = msgs.length > TRIM_AFTER ? msgs.slice(DROP) : msgs;

    // Inject a persistent SESSION_STATE block so the LLM always knows which
    // customer / charger it is dealing with — survives trimming and prevents
    // repeated lookup_customer / get_ticket_summary calls.
    const ctxParts: string[] = [];
    if (slots.customerName)            ctxParts.push(`name=${slots.customerName}`);
    if (slots.mobile)                  ctxParts.push(`mobile=${slots.mobile}`);
    if (slots.chargerSerial)           ctxParts.push(`charger_confirmed=${slots.chargerSerial}${slots.chargerDescription ? ` (${slots.chargerDescription})` : ''}`);
    if (slots.warrantyStatus)          ctxParts.push(`warranty=${slots.warrantyStatus} until ${slots.warrantyEndDate ?? 'N/A'}`);
    if (slots.hasActiveTicket != null) ctxParts.push(`active_ticket=${slots.hasActiveTicket ? (slots.activeTicketNo ?? 'yes') : 'none'}`);
    if (slots.ledState)                ctxParts.push(`led=${slots.ledState}`);
    if (slots.alarm)                   ctxParts.push(`alarm=${slots.alarm}`);

    if (ctxParts.length > 0) {
      const chargerConfirmed = !!slots.chargerSerial;
      const ticketFetched = slots.hasActiveTicket !== undefined;
      const directive = chargerConfirmed && ticketFetched
        ? 'Do NOT call lookup_customer or get_ticket_summary again — charger and ticket history already confirmed.'
        : chargerConfirmed && !ticketFetched
          ? `Charger ${slots.chargerSerial}${slots.chargerDescription ? ` (${slots.chargerDescription})` : ''} is already confirmed. Start your reply by saying "You have selected charger: ${slots.chargerSerial}${slots.chargerDescription ? ` — ${slots.chargerDescription}` : ''}. Let me fetch your service history." Then call get_ticket_summary for this serial, then ask what issue they are facing — do NOT ask for name or mobile.`
          : slots.mobile
            ? 'Mobile is already known. Call lookup_customer immediately using the mobile from SESSION_STATE — do NOT ask for name or mobile again. Then call get_ticket_summary once the charger is confirmed.'
            : 'Call get_ticket_summary once immediately after the customer selects a charger.';

      // Build a compact ticket history block so the LLM can always show timeline
      // even in later turns (tool results are not stored in the session transcript).
      let ticketBlock = '';
      if (slots.recentTickets && slots.recentTickets.length > 0) {
        const lines = slots.recentTickets.map((t) => {
          const tl = t.timeline
            .map((e) => {
              const parts = [e.stage];
              if (e.assignedTo)        parts.push(`(${e.assignedTo})`);
              if (e.actionPerformedBy) parts.push(`by:${e.actionPerformedBy}`);
              if (e.notes)             parts.push(`— ${e.notes}`);
              parts.push(e.createTime.slice(0, 10));
              return parts.join(' ');
            })
            .join(' | ');
          return `  ${t.ticketNo} [${t.status}] ${t.category}/${t.subCategory} raised:${t.ticketDate} timeline: ${tl}`;
        });
        ticketBlock = `\n[TICKET_HISTORY:\n${lines.join('\n')}\n]`;
      }

      return [
        { role: 'user' as const,      content: `[SESSION_STATE: ${ctxParts.join(', ')}. ${directive}]${ticketBlock}` },
        { role: 'assistant' as const, content: 'Understood — I have the full session context including ticket history.' },
        ...trimmed,
      ];
    }
    return trimmed;
  }

  /** Format the server-cached category map as a compact TOON-style block. */
  private buildCategoryBlock(
    categories: Array<{ category: string; subCategories: string[] }>,
  ): string {
    if (!categories.length) return '';
    const lines = categories.map(
      (c) => `${c.category}: ${c.subCategories.join(' | ')}`,
    );
    return `\n\nTICKET_CATEGORIES:\n${lines.join('\n')}\nUse these exact labels in create_ticket category_name and sub_category_name fields.`;
  }

  private stubReply(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    const last = s.transcript[s.transcript.length - 1];
    const reply =
      s.transcript.filter((m) => m.role === 'assistant').length === 0
        ? "Hello! I'm SpinWise, Exicom's virtual assistant. (LLM_API_KEY not configured — this is a stub reply.) May I know your name?"
        : `Stub: received "${last?.content ?? ''}". Configure LLM_API_KEY to enable real responses.`;
    this.sessions.append(sessionId, { role: 'assistant', content: reply });
    return reply;
  }
}
