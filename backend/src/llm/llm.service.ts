import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'fs';
import OpenAI from 'openai';
import { buildSystemPrompt } from '../chat/prompt';
import { TOOL_SCHEMAS } from './tool-schemas';
import { ToolRegistry } from './tools.registry';
import { ChatMessage, ChatSession, SessionService } from '../session/session.service';
import { Attachment } from '../chat/dto';
import { CrmClient } from '../crm/crm.client';

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

@Injectable()
export class LlmService implements OnModuleInit {
  private static readonly MAX_TOOL_ITERATIONS = 8;

  private readonly log = new Logger(LlmService.name);
  private client!: OpenAI;
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
    this.client = new OpenAI({ apiKey: apiKey ?? 'missing-key' });
    this.model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
    this.maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 800);
  }

  // ─── Token usage logger ────────────────────────────────────────────────────
  private static readonly PRICING: Record<string, { inputUSD: number; outputUSD: number }> = {
    'gpt-4o-mini':  { inputUSD: 0.15,  outputUSD: 0.60  },
    'gpt-4o':       { inputUSD: 2.50,  outputUSD: 10.00 },
    'gpt-4-turbo':  { inputUSD: 10.00, outputUSD: 30.00 },
  };
  private static readonly USD_TO_INR = 90;
  private static readonly TOKEN_LOG  = '/tmp/spinwise-token-usage.log';
  private static readonly MAX_RECORDS = 100;

  private logTokenUsage(sessionId: string, inputTokens: number, outputTokens: number, cachedTokens: number, iterations: number) {
    const pricing = LlmService.PRICING[this.model] ?? { inputUSD: 0, outputUSD: 0 };
    // Cached tokens cost 50% of regular input price (OpenAI automatic caching)
    const billableInput = inputTokens - cachedTokens;
    const costUSD = (billableInput / 1_000_000) * pricing.inputUSD
                  + (cachedTokens  / 1_000_000) * (pricing.inputUSD * 0.5)
                  + (outputTokens  / 1_000_000) * pricing.outputUSD;
    const costINR = costUSD * LlmService.USD_TO_INR;
    const record = {
      timestamp:    new Date().toISOString(),
      sessionId,
      model:        this.model,
      inputTokens,
      cachedTokens,
      outputTokens,
      totalTokens:  inputTokens + outputTokens,
      costUSD:      +costUSD.toFixed(6),
      costINR:      +costINR.toFixed(4),
      iterations,
    };

    try {
      let records: typeof record[] = [];
      try {
        records = readFileSync(LlmService.TOKEN_LOG, 'utf8')
          .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch { /* file doesn't exist yet */ }

      records.push(record);
      if (records.length > LlmService.MAX_RECORDS) {
        records = records.slice(records.length - LlmService.MAX_RECORDS);
      }
      writeFileSync(LlmService.TOKEN_LOG, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch (e) {
      this.log.warn(`Token log write failed: ${(e as Error).message}`);
    }

    this.log.log(
      `[tokens] session=${sessionId.slice(0, 8)} ` +
      `in=${inputTokens} cached=${cachedTokens} out=${outputTokens} total=${inputTokens + outputTokens} ` +
      `cost=₹${costINR.toFixed(4)} ($${costUSD.toFixed(6)}) iters=${iterations}`,
    );
  }
  // ──────────────────────────────────────────────────────────────────────────

  /** Build the messages array with system prompt prepended. */
  private async buildMessages(sessionId: string, attachments?: Attachment[]): Promise<OAIMessage[]> {
    const categories = await this.crm.getCategoriesForDisplay();
    const session = this.sessions.get(sessionId);
    const systemPrompt = buildSystemPrompt(session.channel) + this.buildCategoryBlock(categories);
    const history = this.toOpenAIMessages(session.transcript, session.slots);

    if (attachments?.length) {
      const last = history[history.length - 1];
      if (last?.role === 'user') {
        last.content = this.buildMultiModalContent(last.content as string, attachments);
      }
    }

    return [
      { role: 'system', content: systemPrompt },
      ...history,
    ];
  }

  /** Execute tool calls and append results to messages array in-place. */
  private async runTools(
    sessionId: string,
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
    assistantContent: string | null,
    messages: OAIMessage[],
  ) {
    // Append assistant message with tool_calls
    messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: toolCalls,
    });

    // Execute each tool and append result
    for (const tc of toolCalls) {
      const tcFn = tc as { id: string; type: string; function: { name: string; arguments: string } };
      if (tcFn.type !== 'function') continue;
      let result: unknown;
      try {
        const args = JSON.parse(tcFn.function.arguments) as Record<string, unknown>;
        result = await this.tools.dispatch(sessionId, tcFn.function.name, args);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
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
    const messages = await this.buildMessages(sessionId, attachments);

    for (let iter = 0; iter < LlmService.MAX_TOOL_ITERATIONS; iter++) {
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: this.maxTokens,
          messages,
          tools: TOOL_SCHEMAS,
        });
      } catch (e) {
        this.log.error(`OpenAI API error: ${(e as Error).message}`);
        const errReply = 'Sorry, something went wrong on our end. Please try again.';
        this.sessions.append(sessionId, { role: 'assistant', content: errReply });
        return errReply;
      }

      const choice = response.choices[0];
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        await this.runTools(sessionId, choice.message.tool_calls, choice.message.content, messages);
        continue;
      }

      return this.finalizeText(sessionId, choice.message.content ?? '').text;
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
    const messages = await this.buildMessages(sessionId, attachments);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;

    for (let iter = 0; iter < LlmService.MAX_TOOL_ITERATIONS; iter++) {
      const chunks: string[] = [];
      const toolCallsMap: Record<number, { id: string; name: string; arguments: string }> = {};
      let finishReason: string | null = null;

      try {
        const stream = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: this.maxTokens,
          messages,
          tools: TOOL_SCHEMAS,
          stream: true,
          stream_options: { include_usage: true },
        });

        for await (const chunk of stream) {
          // Accumulate usage from the final chunk
          if (chunk.usage) {
            totalInputTokens  += chunk.usage.prompt_tokens ?? 0;
            totalOutputTokens += chunk.usage.completion_tokens ?? 0;
            totalCachedTokens += (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;

          if (delta.content) {
            onChunk(delta.content);
            chunks.push(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallsMap[tc.index]) {
                toolCallsMap[tc.index] = { id: '', name: '', arguments: '' };
              }
              if (tc.id)               toolCallsMap[tc.index].id        += tc.id;
              if (tc.function?.name)   toolCallsMap[tc.index].name      += tc.function.name;
              if (tc.function?.arguments) toolCallsMap[tc.index].arguments += tc.function.arguments;
            }
          }
        }
      } catch (e) {
        this.log.error(`OpenAI stream error: ${(e as Error).message}`);
        const errReply = 'Sorry, something went wrong on our end. Please try again.';
        onChunk(errReply);
        this.sessions.append(sessionId, { role: 'assistant', content: errReply });
        return { text: errReply, closed: false };
      }

      if (finishReason === 'tool_calls') {
        const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = Object.values(toolCallsMap).map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
        await this.runTools(sessionId, toolCalls, chunks.join('') || null, messages);
        continue;
      }

      this.logTokenUsage(sessionId, totalInputTokens, totalOutputTokens, totalCachedTokens, iter + 1);
      return this.finalizeText(sessionId, chunks.join(''));
    }

    const fallback = 'I am having trouble completing that step. Would you like me to raise a complaint and have an engineer follow up?';
    onChunk(fallback);
    this.sessions.append(sessionId, { role: 'assistant', content: fallback });
    return { text: fallback, closed: false };
  }

  /**
   * Build a multi-modal content array for a user message that includes file attachments.
   * Images → image_url blocks. PDFs / videos → text note.
   */
  private buildMultiModalContent(
    text: string,
    attachments: Attachment[],
  ): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
    const blocks: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

    for (const att of attachments) {
      if (att.type === 'image') {
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${att.mediaType};base64,${att.data}` },
        });
      } else if (att.type === 'pdf') {
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

  private toOpenAIMessages(
    transcript: ChatMessage[],
    slots: ChatSession['slots'],
  ): OAIMessage[] {
    const msgs: OAIMessage[] = transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Sliding window: once > 12 messages, drop the oldest 4 pairs (8 messages).
    const TRIM_AFTER = 12;
    const DROP = 8;
    const trimmed = msgs.length > TRIM_AFTER ? msgs.slice(DROP) : msgs;

    const ctxParts: string[] = [];
    if (slots.customerName)            ctxParts.push(`name=${slots.customerName}`);
    if (slots.mobile)                  ctxParts.push(`mobile=${slots.mobile}`);
    if (slots.chargerSerial)           ctxParts.push(`charger_confirmed=${slots.chargerSerial}${slots.chargerDescription ? ` (${slots.chargerDescription})` : ''}`);
    if (slots.warrantyStatus)          ctxParts.push(`warranty=${slots.warrantyStatus} until ${slots.warrantyEndDate ?? 'N/A'}`);
    // active_ticket is intentionally NOT injected into SESSION_STATE.
    // The LLM must always call get_ticket_summary at Stage 5 to get a fresh check —
    // never rely on remembered state which can be misread and cause hallucination.
    if (slots.ledState)                ctxParts.push(`led=${slots.ledState}`);
    if (slots.alarm)                   ctxParts.push(`alarm=${slots.alarm}`);

    if (ctxParts.length > 0) {
      const chargerConfirmed = !!slots.chargerSerial;
      const ticketFetched = slots.hasActiveTicket !== undefined;
      const directive = slots.restored
        ? 'RESUMED CONVERSATION — the customer is returning to a previous chat. All their details are already known. Do NOT re-introduce yourself. Do NOT ask for name, mobile, or serial again. Do NOT call lookup_customer or get_ticket_summary. Just acknowledge you are picking up where you left off and continue naturally from the last message in the transcript.'
        : chargerConfirmed && ticketFetched
          ? 'Do NOT call lookup_customer again — charger already confirmed. You MAY call get_ticket_summary again at Stage 5 (ticket creation) to get a fresh check — always use the tool result, never guess.'
          : chargerConfirmed && !ticketFetched
            ? `Charger ${slots.chargerSerial}${slots.chargerDescription ? ` (${slots.chargerDescription})` : ''} is already confirmed. Call get_ticket_summary for this serial immediately, then continue naturally from the conversation — do NOT re-ask what issue they are facing if it has already been described earlier in this conversation. Do NOT ask for name or mobile.`
            : slots.mobile
              ? 'Mobile is already known. Call lookup_customer immediately using the mobile from SESSION_STATE — do NOT ask for name or mobile again. Then call get_ticket_summary once the charger is confirmed.'
              : 'Call get_ticket_summary once immediately after the customer selects a charger.';

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
