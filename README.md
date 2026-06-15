# SpinWise Chatbot — Exicom AC Charger Customer Care

Interactive chatbot that triages charger / Spin App / RFID / ticket-status
issues for Exicom AC chargers, hands off to a live NOC engineer when remote
diagnostics are needed, and raises a CRM ticket when self-serve fails.

Two surfaces, one backend:

- **Spin App Support section** — Flutter widget ([`flutter-widget/`](./flutter-widget))
- **Public URL + embeddable widget** — Vanilla JS ([`web-widget/`](./web-widget))

Conversation behaviour comes from the v1.2 spec
([Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx](./Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx))
— Part 7 *is* the system prompt; Parts 3-5 are encoded as deterministic
tools so the model never hallucinates LED states, NE thresholds, fault
behavior, or ticket IDs.

## Layout

```
Spin-ChatBot/
├── Exicom_AC_Charger_Support_Chatbot_Flow_v1.2.docx   ← canonical spec
├── docs/
│   └── ARCHITECTURE.md             ← design, integration, security
├── backend/                        ← NestJS service
│   └── src/{chat,llm,knowledge,crm,session}
├── web-widget/                     ← standalone URL + iframe embed
│   ├── index.html
│   ├── widget.html
│   └── embed.js
└── flutter-widget/                 ← Flutter package for the Spin App
    ├── lib/spinwise_chat.dart
    └── example/                    ← runnable demo Support screen
```

## Quick start (end-to-end, prototype mode)

```bash
# 1) Backend — fixtures kick in when CRM_BASE_URL is unset
cd backend
cp .env.example .env          # paste ANTHROPIC LLM_API_KEY here
npm install
npm run start:dev             # http://localhost:4000

# 2) Web widget
cd ../web-widget
python -m http.server 5173    # http://localhost:5173

# 3) Flutter widget (optional)
cd ../flutter-widget/example
flutter pub get
flutter run                   # uses http://10.0.2.2:4000/api on Android emu
```

Try one of the fixture mobiles in the chat:
- `9876543277` — Tata/Compact, BLE-only, active warranty
- `9876543299` — Spin Air, **expired** warranty (triggers charges-consent flow)
- `9876543288` — has an open ticket (triggers dedup branch)
- `0000000000` — lookup not found

## Tech choices (and why)

| Component       | Choice                                   | Why                                           |
|-----------------|------------------------------------------|-----------------------------------------------|
| Backend         | **NestJS** on Node.js                    | Matches the Spin backend stack                |
| Bot engine      | **LLM-first** (Anthropic) + tool use     | Part 7 prompt drops in verbatim; safety-critical data stays out of the model |
| Mobile          | **Flutter** package                      | Spin App is Flutter — embed as a screen      |
| Web             | Vanilla JS standalone + iframe embed     | < 30 KB, no framework lock-in, easy to host  |
| CRM             | **Custom REST contract**                 | Wired to your in-house ticketing service     |

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design,
sequence diagram, CRM contract, security/privacy posture, and the production
checklist.

## Integration steps (summary)

### Spin App (Flutter)
1. Add `spinwise_chat` as a path/git dependency.
2. Add a `ListTile` in your Support screen → push `SpinWiseChatScreen`.
3. Pass `prefill` (name, mobile, charger serial) so the bot skips Stage 2.
4. Configure `apiBaseUrl` to point at the deployed chatbot service.

### Web
1. Host `web-widget/` behind a public URL (e.g. `support.exicom-ps.com/chat`).
2. For Exicom website embed: include `<script src="…/embed.js" data-api="…" data-widget="…">`.
3. Allow the host origins in the backend's `CORS_ALLOWED_ORIGINS`.

### Backend
1. Deploy `backend/` (Docker-friendly NestJS app).
2. Provide env vars: `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`,
   `CRM_BASE_URL`, `CRM_TOKEN`, `NOC_HANDOFF_WEBHOOK`,
   `CORS_ALLOWED_ORIGINS`.
3. Wire your CRM endpoints to the four contracts in
   [`crm.types.ts`](./backend/src/crm/crm.types.ts) — change the URL paths in
   `crm.client.ts`; the rest of the bot is untouched.

## What's NOT in this prototype (deferred)

- Real CRM auth (mTLS / key rotation) — currently bearer token.
- Redis-backed sessions (current store is in-memory; ready for an adapter).
- Photo upload pipeline to object storage (current behaviour: filenames stashed).
- Azure OpenAI adapter (Anthropic adapter is wired; Azure is one file).
- End-to-end golden conversation tests.
- Live NOC presence/queue (current handoff is a webhook fire-and-forget).
