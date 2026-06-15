# SpinWise Backend

NestJS service that orchestrates the SpinWise chatbot conversation. The LLM
follows the Part 7 prompt from
[`Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx`](../Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx);
deterministic behaviour (LED → state, fault → resolution, CRM calls) lives
behind tool-use calls so the model never invents safety-critical data.

## Run

```bash
cp .env.example .env
# fill in LLM_API_KEY, LLM_MODEL, CRM_BASE_URL/CRM_TOKEN, NOC_HANDOFF_WEBHOOK
npm install
npm run start:dev
```

When `CRM_BASE_URL` is unset the client returns deterministic fixtures so the
bot is end-to-end runnable. Fixture mobiles:

| Suffix | Behaviour                                |
|--------|------------------------------------------|
| `…99`  | Warranty Expired (triggers charges flow) |
| `…77`  | Tata/Compact charger, BLE-only           |
| `…88`  | Has an open ticket (dedup check)         |
| `0000000000` | Lookup returns "not found"         |

## HTTP API

```
POST   /api/chat/session                    → { sessionId, channel }
POST   /api/chat/session/:id/message        → { reply, slots, ticketId? }
GET    /api/chat/session/:id                → full transcript
WS     /chat   event "message" / "reply"    → streamed conversation
```

## Folder map

```
src/
  main.ts                          # bootstrap (CORS, global prefix)
  app.module.ts
  chat/
    prompt.ts                      # Part-7 system prompt (verbatim from spec)
    chat.controller.ts
    chat.gateway.ts                # WebSocket
    chat.service.ts                # idle timer + send/start/history
    dto.ts
  llm/
    llm.service.ts                 # Anthropic adapter + tool-use loop
    tool-schemas.ts                # Anthropic tool definitions
    tools.registry.ts              # server-side dispatch
  knowledge/
    led-map.json                   # LED → state table
    faults.json                    # alarm → steps + severity table
    knowledge.service.ts
  crm/
    crm.client.ts                  # in-house ticketing client (+ fixtures)
    crm.types.ts
  session/
    session.service.ts             # in-memory store + slot tracking
```

## Notes on changing behavior

- **Conversation behaviour**: edit Part 7 in the docx, then re-export to
  `src/chat/prompt.ts`. Do not drift the prompt independently.
- **LED map / fault table**: edit the JSON files. They are bundled into the
  build via `nest-cli.json` `assets`.
- **CRM contract**: replace `crm.client.ts` body — types stay the same.
