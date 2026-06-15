# SpinWise Chatbot — Architecture & Integration Plan

**Project:** Exicom SpinWise — AC Charger Support Chatbot
**Spec source:** [Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx](../Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx)
**Version:** 1.0 prototype • 2026-06-11

---

## 1. Goals

The chatbot ("SpinWise") must:

1. Be reachable from **two surfaces** with the same backend session model:
   - **In-app** — embedded into the Spin App (Flutter) under the *Support* section.
   - **Web** — a standalone public URL plus an embeddable iframe widget for the Exicom website.
2. Walk the v1.2 conversation flow: greeting → triage (Charger / App / RFID / Ticket-Status / Other) → backend lookup → branch-specific troubleshooting → NOC handoff if needed → ticket creation with warranty check.
3. Talk to the **in-house CRM/ticketing API** for customer lookup, dedup, and ticket creation.
4. Be safe by construction: never invent LED states, NE-voltage thresholds, fault names, or ticket IDs — those come from server-side tools, not the LLM.

## 2. High-level architecture

```
                      ┌────────────────────────┐
                      │  Spin App (Flutter)    │
                      │  Support → SpinWise    │──┐
                      └────────────────────────┘  │
                                                  │  HTTPS / WSS
                      ┌────────────────────────┐  │
                      │  Web Widget (JS)       │──┤
                      │  • standalone URL      │  │
                      │  • iframe-embeddable   │  │
                      └────────────────────────┘  │
                                                  ▼
                                        ┌───────────────────────┐
                                        │  SpinWise Backend     │
                                        │  (NestJS)             │
                                        │                       │
                                        │  • /chat/session      │
                                        │  • /chat/message      │
                                        │  • /chat/stream (WS)  │
                                        │  • /chat/upload       │
                                        │  • /chat/handoff      │
                                        └─────────┬─────────────┘
                                                  │
              ┌───────────────────────────────────┼──────────────────────────────┐
              │                                   │                              │
              ▼                                   ▼                              ▼
   ┌───────────────────┐               ┌───────────────────┐         ┌────────────────────┐
   │  LLM Provider     │               │  In-house CRM     │         │  NOC Handoff Bus   │
   │  (Anthropic or    │               │  Ticketing API    │         │  (e.g. Slack /     │
   │   Azure OpenAI)   │               │                   │         │   internal portal) │
   │  • tool use       │               │  • lookup         │         │                    │
   └───────────────────┘               │  • tickets CRUD   │         └────────────────────┘
                                       └───────────────────┘
```

## 3. Why LLM-first with deterministic tools

The v1.2 spec already provides (Part 7) a complete *deployable agent prompt*. An LLM-first design lets us drop that prompt in verbatim and evolve it by editing the docx. To keep safety-critical data out of the model, we expose these as **tool calls**:

| Tool                      | Backed by                  | Purpose                                                                |
|---------------------------|----------------------------|------------------------------------------------------------------------|
| `lookup_customer`         | CRM `/customers/lookup`    | Resolve mobile → charger model/serial/connectivity/warranty/open-tickets |
| `get_open_tickets`        | CRM `/tickets?mobile=`     | Open-ticket dedup check                                                |
| `get_led_state`           | local `led-map.json`       | Translate (model, colour, pattern, speed) → canonical state            |
| `get_fault_resolution`    | local `faults.json`        | Look up customer-steps / NOC-steps / ticket-trigger by alarm name      |
| `request_noc_handoff`     | NOC bus                    | Page a live agent with full context; falls back to a flagged ticket    |
| `check_warranty`          | CRM `/customers/{id}/warranty` | Active vs Expired + visit-charge disclosure flag                   |
| `create_ticket`           | CRM `POST /tickets`        | Build the Part-5 schema and submit                                     |
| `get_ticket_status`       | CRM `GET /tickets/{id}`    | For the Ticket-Status branch (Stage 3D)                                |

The LLM **never** decides what NE voltage is "healthy" or which alarm triggers a critical ticket — those are returned by the tools as structured data. This is what protects against the prompt-injection / hallucination failure modes that would otherwise be unacceptable for a safety-adjacent EV-charger flow.

## 4. Components

### 4.1 Backend service (`backend/`, NestJS)

- `ChatModule` — session lifecycle, message endpoint, WebSocket streaming, upload handler.
- `LlmModule` — provider-agnostic adapter (Anthropic by default, Azure OpenAI swap via env). Handles tool-use loop until the model returns a final assistant message.
- `KnowledgeModule` — ships the LED state map and the fault/alarm table as JSON, served as tools.
- `CrmModule` — typed HTTP client for the in-house ticketing API. Single place to swap base URL / auth.
- `SessionModule` — in-memory map by default (Redis adapter ready). Stores transcript + collected slots (name, mobile, charger model/serial, LED state, alarm name, photos, steps tried).

### 4.2 Web widget (`web-widget/`)

- `index.html` — standalone chat experience at e.g. `https://support.exicom-ps.com/chat`.
- `widget.html` + `embed.js` — drop-in `<script>` snippet that injects a floating chat bubble + iframe.
- Vanilla JS, no framework, < 30 KB gzipped, fully responsive (mobile + desktop).

### 4.3 Flutter widget (`flutter-widget/`)

A Flutter package exposing `SpinWiseChatScreen()` plus a `SpinWiseSupportTile()` for the Support menu. To integrate into the Spin App:

```dart
// In your Support section:
ListTile(
  leading: const Icon(Icons.chat_bubble_outline),
  title: const Text('Chat with SpinWise'),
  onTap: () => Navigator.push(context, MaterialPageRoute(
    builder: (_) => SpinWiseChatScreen(
      apiBaseUrl: AppConfig.chatbotBaseUrl,
      authToken: session.idToken,            // user is already logged in
      prefill: ChatPrefill(
        name: session.user.name,
        mobile: session.user.mobile,
        chargerSerial: selectedCharger?.serial,
      ),
    ),
  )),
),
```

Pre-filling these fields means the bot skips Stage 2 inside the app context.

## 5. Conversation orchestration

```
User msg ──► ChatController
            │
            ▼
        SessionService.append(role=user, content)
            │
            ▼
        LlmService.respond(transcript, system=PART7_PROMPT, tools=[...])
            │
            ├── while model returns tool_use:
            │     ├── lookup_customer({mobile})       → CrmClient
            │     ├── get_led_state({model, colour, pattern, speed}) → Knowledge
            │     ├── get_fault_resolution({alarm})   → Knowledge
            │     ├── check_warranty({customerId})    → CrmClient
            │     ├── request_noc_handoff({context})  → NocBus
            │     └── create_ticket({...Part5 schema}) → CrmClient
            │
            ▼
        Final assistant text streamed to client over WS,
        appended to session transcript.
```

Idle handling (Part 6): a per-session timer fires after 5 minutes of silence with the "Are you still there?" nudge; after 5 more minutes the session is closed and any ticket number is preserved.

## 6. CRM API contract (proposed)

Each endpoint is a thin REST contract. The Spin team maps these to the actual in-house service.

```http
GET  /v1/customers/lookup?mobile=98XXXXXX21
     → 200 {
         customerId, name, addressPincode,
         chargers: [{model, serial, connectivity, warrantyStatus, mfgCode}],
         openTickets: [{ticketId, issueCategory, status, eta}]
       }

GET  /v1/customers/{id}/warranty
     → 200 { status: "Active"|"Expired", expiresOn, plan }

GET  /v1/tickets/{id}
     → 200 { ticketId, status, engineerEta, lastUpdate, severity }

POST /v1/tickets
     body: <Part-5 ticket schema>
     → 201 { ticketId }

POST /v1/handoff
     body: { sessionId, transcriptRef, context: {ledState, alarm, stepsTried} }
     → 202 { handoffId, etaSeconds }
```

Auth: short-lived JWT minted by the Spin App for the in-app surface; service-to-service token for the public web widget.

## 7. Security & privacy

- **Mobile-number privacy line** is part of the system prompt; the backend additionally tags the field at storage time so it can be redacted from transcripts before they leave the EU/India region.
- **PII boundary** — photos uploaded via the widget are stored in object storage with a per-session prefix, signed-URL access only, 30-day retention by default.
- **Prompt-injection** — tool outputs are JSON-only; we never let tool responses become free-text rendered as assistant content.
- **Rate limiting** — IP + sessionId leaky-bucket on `/chat/message` (default 30 req/min, 6 burst).
- **Safety overrides** — the burnt-MCB / smoke / spark stop is enforced at the prompt level *and* by a server-side check on `create_ticket`: if the user described `burnt_mcb=true` the ticket is forced to severity=Critical and flagged "Customer-side electrical repair advised".

## 8. Integration steps

### 8.1 Spin App (Flutter)

1. Add `flutter-widget/` as a path or git dependency in `pubspec.yaml`.
2. Configure `SpinWiseConfig.init(apiBaseUrl: ..., authTokenProvider: () => session.idToken)` at app startup.
3. Add a tile to the existing Support screen → push `SpinWiseChatScreen`.
4. Wire deep link `spinapp://support/chat?topic=<>` for push-notification follow-ups.

### 8.2 Web (standalone URL + embed)

1. Host `web-widget/dist/` behind `https://support.exicom-ps.com/chat`.
2. For embed: include `<script src="https://support.exicom-ps.com/embed.js" data-base="https://chatbot-api.exicom-ps.com"></script>` on the Exicom site.
3. CORS allow-list on the backend: the Exicom site, the support URL, and `capacitor://` / `flutter://` for the in-app surface.

### 8.3 Backend deployment

1. Deploy `backend/` (Docker image included) behind the same API gateway used by the Spin backend.
2. Provide env vars: `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `CRM_BASE_URL`, `CRM_TOKEN`, `SESSION_STORE` (in-memory|redis), `REDIS_URL`.
3. Subscribe the NOC team's Slack / portal webhook URL to `NOC_HANDOFF_WEBHOOK`.
4. Mount the LED + fault JSON files (or bake into image). Update by re-deriving from the docx + redeploying.

### 8.4 Observability

- Structured logs: `sessionId`, `stage`, `ledState`, `alarm`, `toolName`, `latencyMs`.
- Metrics: tool-call counters, handoff rate, ticket-creation rate, resolution-without-ticket rate, CSAT distribution.
- Conversation transcripts archived with 30-day TTL by default; consent line in the greeting satisfies the disclosure requirement.

## 9. What this prototype includes vs defers

| Area                             | Prototype                        | Defer to production                          |
|----------------------------------|----------------------------------|----------------------------------------------|
| LLM tool-use loop                | ✅ Anthropic adapter             | Azure OpenAI adapter (1 file)                |
| Session store                    | ✅ In-memory                     | Redis adapter, multi-pod fan-out             |
| CRM client                       | ✅ Typed stub returning fixtures | Real auth + retries + circuit breaker        |
| NOC handoff                      | ✅ Webhook stub                  | Live presence / queue / SLA timers           |
| Web widget                       | ✅ Standalone + embed            | Brand themeing system, dark mode             |
| Flutter widget                   | ✅ Drop-in screen + prefill      | Photo capture, BLE-status hint, theming      |
| Auth                             | ✅ Bearer-token pass-through     | mTLS to CRM, key rotation                    |
| Tests                            | ✅ Unit-test outline             | E2E suite per stage, golden conversations    |

## 10. Open questions to confirm before go-live

1. Exact CRM endpoint paths + auth scheme (current contract is provisional).
2. SLA-hour values per severity (the doc explicitly says *don't quote unverified timelines*).
3. Photo/video upload size limits + region.
4. NOC presence/handoff channel (Slack? internal portal? phone?).
5. CSAT storage destination (CRM custom field vs separate analytics table).
