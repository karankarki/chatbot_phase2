import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { appendFile } from 'fs';
import OpenAI from 'openai';
import { buildSystemPrompt } from '../chat/prompt';
import { TOOL_SCHEMAS } from './tool-schemas';
import { ToolRegistry } from './tools.registry';
import { ChatMessage, ChatSession, SessionService } from '../session/session.service';
import { Attachment } from '../chat/dto';
import { CrmClient } from '../crm/crm.client';
import { scanQrFromBase64, extractSerialFromQr } from './qr-scanner';

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

@Injectable()
export class LlmService implements OnModuleInit {
  private static readonly MAX_TOOL_ITERATIONS = 8;

  private readonly log = new Logger(LlmService.name);
  private client: OpenAI | null = null;
  private model!: string;
  private maxTokens!: number;

  /** Cached system prompt strings keyed by channel, invalidated when category map refreshes. */
  private readonly promptCache = new Map<string, { prompt: string; categoryFetchedAt: number }>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly sessions: SessionService,
    private readonly crm: CrmClient,
  ) {}

  onModuleInit() {
    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey) {
      this.log.warn('LLM_API_KEY not set — chat will return a stub response.');
    } else {
      this.client = new OpenAI({ apiKey });
    }
    this.model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
    this.maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 800);
    // Pre-warm CRM: fetch auth token + category map at startup so the first
    // user request doesn't pay the cold-start network round trips.
    this.crm.getCategoriesForDisplay().catch(() => {});
  }

  // ─── Token usage logger ────────────────────────────────────────────────────
  private static readonly PRICING: Record<string, { inputUSD: number; outputUSD: number }> = {
    'gpt-4o-mini':  { inputUSD: 0.15,  outputUSD: 0.60  },
    'gpt-4o':       { inputUSD: 2.50,  outputUSD: 10.00 },
    'gpt-4-turbo':  { inputUSD: 10.00, outputUSD: 30.00 },
  };
  private static readonly USD_TO_INR = 90;
  private static readonly TOKEN_LOG  = '/tmp/spinwise-token-usage.log';

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

    appendFile(LlmService.TOKEN_LOG, JSON.stringify(record) + '\n', 'utf8', () => {});

    this.log.log(
      `[tokens] session=${sessionId.slice(0, 8)} ` +
      `in=${inputTokens} cached=${cachedTokens} out=${outputTokens} total=${inputTokens + outputTokens} ` +
      `cost=₹${costINR.toFixed(4)} ($${costUSD.toFixed(6)}) iters=${iterations}`,
    );
  }
  // ──────────────────────────────────────────────────────────────────────────

  /** Return the system prompt string for a channel, rebuilding only when categories refresh. */
  private async getSystemPrompt(channel: string): Promise<string> {
    const categoryFetchedAt = this.crm.getCategoryFetchedAt();
    const cached = this.promptCache.get(channel);
    if (cached && cached.categoryFetchedAt === categoryFetchedAt) return cached.prompt;
    const categories = await this.crm.getCategoriesForDisplay();
    const prompt = buildSystemPrompt(channel as 'web-widget' | 'in-app') + this.buildCategoryBlock(categories);
    this.promptCache.set(channel, { prompt, categoryFetchedAt: this.crm.getCategoryFetchedAt() });
    return prompt;
  }

  /** Build the messages array with system prompt prepended. */
  private async buildMessages(sessionId: string, attachments?: Attachment[]): Promise<OAIMessage[]> {
    const session = this.sessions.get(sessionId);
    const systemPrompt = await this.getSystemPrompt(session.channel);
    const history = this.toOpenAIMessages(session.transcript, session.slots);

    if (attachments?.length) {
      const last = history[history.length - 1];
      if (last?.role === 'user') {
        const lastBotMsg = [...session.transcript].reverse().find((m) => m.role === 'assistant')?.content ?? '';
        last.content = await this.buildMultiModalContent(last.content as string, attachments, lastBotMsg);
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

    // Execute all function tool calls in parallel, then push results in original order.
    const results = await Promise.all(
      toolCalls
        .filter((tc) => (tc as any).type === 'function')
        .map(async (tc) => {
          const tcFn = tc as { id: string; function: { name: string; arguments: string } };
          let result: unknown;
          try {
            const args = JSON.parse(tcFn.function.arguments) as Record<string, unknown>;
            result = await this.tools.dispatch(sessionId, tcFn.function.name, args);
          } catch (e) {
            result = { error: (e as Error).message };
          }
          return { id: tc.id, result };
        }),
    );
    for (const { id, result } of results) {
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
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
    const client = this.client;
    if (!client) return this.stubReply(sessionId);
    const messages = await this.buildMessages(sessionId, attachments);

    for (let iter = 0; iter < LlmService.MAX_TOOL_ITERATIONS; iter++) {
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await client.chat.completions.create({
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
    const client = this.client;
    if (!client) {
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
        const stream = await client.chat.completions.create({
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
   * lastBotMsg is passed so context-aware hints can be injected (e.g. alarm screenshot check).
   */
  private async buildMultiModalContent(
    text: string,
    attachments: Attachment[],
    lastBotMsg = '',
  ): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
    const blocks: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

    // Detect the current conversational context so the LLM knows how to interpret the image.
    const botWaitingForAlarm   = /alarm.*screen|Support.*Alarms|Alarms.*screen|type.*alarm|alarm name/i.test(lastBotMsg);
    const botAskingBurntMarks  = /burnt.*mark|black.*mark|burn.*mark|marks.*mcb|scorch|burnt.*charger|damaged.*charger/i.test(lastBotMsg);

    for (const att of attachments) {
      if (att.type === 'image') {
        if (botWaitingForAlarm) {
          blocks.push({
            type: 'text',
            text: `[IMAGE CONTEXT: The customer was asked to provide the alarm name from the Spin App Alarms screen. Determine whether this image IS actually the Alarms screen. If YES (shows alarm entries with names like "Mains Fail", "Earth Detect", etc.): extract all alarm names visible and immediately start troubleshooting the top alarm — do NOT ask the customer to type the name again. If NO (charger photo, sticker, unrelated image, or any other screen): say "The image you sent does not appear to be the Alarms screen. Please go to Support → Alarms in the Spin App and send a screenshot of that screen, or type the alarm name directly here." Do not proceed with troubleshooting until the alarm name is confirmed.]`,
          });
        } else if (botAskingBurntMarks) {
          blocks.push({
            type: 'text',
            text: `[IMAGE CONTEXT: The customer was asked whether there are any burnt or black marks on the MCB or charger. Carefully examine this image for: 1) Black or dark-brown scorch marks on any surface, 2) Burnt, melted, or charred wire insulation, 3) Discoloured or heat-damaged circuit breakers or components, 4) Any evidence of fire, arcing, or overheating. If burnt/damaged areas ARE clearly visible: treat this as YES to the burnt marks question — apply the safety protocol immediately (do not touch equipment, call electrician, raise priority ticket). If NO burnt marks are visible: treat as NO and proceed to the MCB check (step b). If the image is unclear or does not show the MCB/charger: ask "I could not see the MCB or charger clearly in the image. Could you upload a closer photo, or simply type Yes or No?"]`,
          });
        } else {
          blocks.push({
            type: 'text',
            text: `[IMAGE CONTEXT: Analyze this image intelligently based on the current stage of the conversation. Determine what the image shows and extract any information useful for the current step: serial number on sticker (extract characters after #), LED colour and pattern, MCB/charger condition, or other relevant details. If the image is relevant and useful — extract the information and continue the workflow naturally. If the image is unclear, unreadable, or does not contain useful information for the current step — describe what you can see, note it does not help the current step, and ask for the specific information needed.]`,
          });
        }

        // Try QR scan first — if it succeeds, use that serial exclusively
        const qrValue = await scanQrFromBase64(att.data);
        if (qrValue) {
          const serial = extractSerialFromQr(qrValue);
          if (serial) {
            // QR scan succeeded — inject serial and image (for safety scan only)
            blocks.push({
              type: 'text',
              text: `[QR SCAN SUCCESS — Serial number: "${serial}". This is the confirmed serial for this session. DO NOT read or extract any serial from the sticker text in the image — the QR result is authoritative. DO NOT mention the "#" symbol or any prefix to the customer. Proceed using serial "${serial}" directly.]`,
            });
            blocks.push({
              type: 'image_url',
              image_url: { url: `data:${att.mediaType};base64,${att.data}` },
            });
          } else {
            // QR decoded but serial extraction failed — let LLM read the sticker
            blocks.push({
              type: 'text',
              text: `[QR code could not yield a valid serial. Please read the serial number from the sticker text in the image — extract only the characters after the "#" symbol.]`,
            });
            blocks.push({
              type: 'image_url',
              image_url: { url: `data:${att.mediaType};base64,${att.data}` },
            });
          }
        } else {
          // No QR detected — let LLM read the sticker text
          blocks.push({
            type: 'text',
            text: `[No QR code detected in image. Please read the serial number from the sticker text — extract only the characters after the "#" symbol, ignoring everything before it.]`,
          });
          blocks.push({
            type: 'image_url',
            image_url: { url: `data:${att.mediaType};base64,${att.data}` },
          });
        }
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

  /**
   * Scan the transcript and return a list of topics already answered by the customer.
   * Injected as [ALREADY_COVERED] so the LLM knows not to re-ask.
   */
  private buildAnsweredQuestionsBlock(transcript: ChatMessage[]): string {
    const covered = new Set<string>();

    for (let i = 0; i < transcript.length; i++) {
      const msg = transcript[i];

      // When the bot asks a question and there is a subsequent user reply, mark the topic.
      if (msg.role === 'assistant' && msg.content.includes('?')) {
        const hasReply = transcript.slice(i + 1).some((m) => m.role === 'user');
        if (!hasReply) continue;

        const low = msg.content.toLowerCase();
        if (/burnt|black\s*mark|scorch|burn\s*mark/.test(low))          covered.add('burnt or black marks');
        if (/\bMCB\b/.test(msg.content))                                 covered.add('MCB status');
        if (/led|colour|color|light.*blink|blink.*light/.test(low))      covered.add('LED colour and pattern');
        if (/alarm|fault name/.test(low))                                covered.add('alarm or fault name');
        if (/serial|sticker/.test(low))                                  covered.add('charger serial');
        if (/mobile|phone number|registered number/.test(low))           covered.add('mobile number');
        if (/your name|may i know your name|what.?s your name/.test(low)) covered.add('customer name');
        if (/is it charging|charging now|started charging/.test(low))    covered.add('whether charging now');
        if (/anything else|is there anything/.test(low))                 covered.add('anything else needed');
        if (/restart|switch.*off|turn.*off|mcb.*off/.test(low))          covered.add('MCB restart step');
        if (/issue|problem|facing|trouble|complaint/.test(low))          covered.add('issue description');
        if (/vehicle|car|model.*vehicle|ev\b/.test(low))                 covered.add('vehicle type');
        if (/which charger|select.*charger|charger.*issue/.test(low))    covered.add('charger selection');
        if (/rated current|current setting/.test(low))                   covered.add('rated current setting');
      }

      // When the user explicitly provides information, mark it as covered.
      if (msg.role === 'user') {
        const low = msg.content.toLowerCase();
        if (/\b(red|green|blue|white|yellow|cyan|pink)\b.*(led|light|blink|solid|flash)/i.test(msg.content) ||
            /\b(led|light)\b.*(red|green|blue|white|yellow|cyan|pink)\b/i.test(msg.content)) {
          covered.add('LED colour and pattern');
        }
        if (/\b(earth|mains\s*fail|mains\s*low|mains\s*high|phase\s*fail|pwm\s*fault|weld|temperature\s*high|emergency|spd\b|connectivity|mfu|gsm|wifi\s*ble|ext\s*eep|ext\s*rs|em\s*comm|em\s*ic|sd\s*card|charging\s*zero)/i.test(msg.content)) {
          covered.add('alarm or fault name');
        }
        if (/restart|restarted|switched.*off|turned.*off|power.*off|mcb.*off|already.*tried|tried.*restart/i.test(low)) {
          covered.add('restart attempts already tried');
        }
        if (/burnt|burn|black\s*mark|scorch|smoke|no.*burn|no.*mark/i.test(low)) {
          covered.add('burnt or black marks');
        }
        if (/\bMCB\b.*(on|off|yes|no|it.?s|checked|switch)/i.test(msg.content) ||
            /(yes|no|it.?s|checked|on|off).*\bMCB\b/i.test(msg.content)) {
          covered.add('MCB status');
        }
      }
    }

    if (covered.size === 0) return '';

    const list = [...covered].join('; ');
    return `\n[ALREADY_COVERED: ${list}. These topics have already been addressed in this conversation. Do NOT ask the customer about any of them again — this is a mandatory check before generating any follow-up question.]`;
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
    if (slots.mcbChecked)              ctxParts.push(`mcb_checked=true`);

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
        ticketBlock = `\n[TICKET_HISTORY — SEALED: This data is for internal reference only. Do NOT mention, summarise, or reveal any of this ticket information to the customer unless they explicitly ask for complaint status OR you are at Stage 5 about to call create_ticket. Revealing ticket history at any other point is a hard violation.\n${lines.join('\n')}\n]`;
      }

      const coveredBlock = this.buildAnsweredQuestionsBlock(transcript);
      return [
        { role: 'user' as const,      content: `[SESSION_STATE: ${ctxParts.join(', ')}. ${directive}]${ticketBlock}${coveredBlock}` },
        { role: 'assistant' as const, content: 'Understood — I have the full session context including ticket history and the list of topics already covered.' },
        ...trimmed,
      ];
    }

    // Even without structured slots, inject the covered-topics block so the LLM
    // knows not to re-ask for information provided early in the conversation.
    const coveredBlock = this.buildAnsweredQuestionsBlock(transcript);
    if (coveredBlock) {
      return [
        { role: 'user' as const,      content: coveredBlock },
        { role: 'assistant' as const, content: 'Understood — I will not re-ask for any information already provided.' },
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
