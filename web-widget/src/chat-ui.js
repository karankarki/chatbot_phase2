/**
 * SpinWise chat UI — vanilla JS, no framework.
 */

const cfg     = window.SpinWiseConfig || {};
const API     = (cfg.apiBaseUrl || '/api').replace(/\/$/, '');
const CHANNEL = cfg.channel || 'web-widget';
const MAX_FILE_SIZE_MB = 10;

const ISSUE_TYPES = [
  'Charger not working',
  'Charger not charging',
  'App issue',
  'RFID issue',
  'Check complaint status',
];

// ─── Root ─────────────────────────────────────────────────────────────────────

const root = document.getElementById('spinwise-root');
if (!root) throw new Error('SpinWise: #spinwise-root not found');

root.innerHTML = `
  <header class="chat__header">
    <div class="chat__header__lhs">
      <div class="chat__header__titleblock">
        <div class="chat__header__title">
          <span class="chat__status-dot"></span>SpinWise
        </div>
        <div class="chat__header__wordmark" aria-label="by exicom">exicom · virtual assistant</div>
      </div>
    </div>
    <button class="chat__attach" id="sw-restart" title="Start over"
      style="background:transparent;border-color:rgba(255,255,255,0.18);color:rgba(255,255,255,0.85)">↻</button>
  </header>
  <div class="chat__body" id="sw-body" aria-live="polite"></div>
  <div class="chat__previews" id="sw-previews"></div>
  <form class="chat__composer" id="sw-form">
    <label class="chat__attach" title="Attach image, PDF or video">
      📎
      <input type="file" id="sw-file" accept="image/*,application/pdf,video/*" multiple hidden />
    </label>
    <textarea id="sw-input" placeholder="Type your message…" rows="1" required></textarea>
    <button class="chat__composer__send" id="sw-send" type="submit">Send</button>
  </form>
`;

const body       = root.querySelector('#sw-body');
const previews   = root.querySelector('#sw-previews');
const form       = root.querySelector('#sw-form');
const input      = root.querySelector('#sw-input');
const sendBtn    = root.querySelector('#sw-send');
const restartBtn = root.querySelector('#sw-restart');
const fileInput  = root.querySelector('#sw-file');

let sessionId      = null;
let sessionClosed  = false;
let firstBotMsg    = true;          // show issue-type buttons after the very first greeting
let pendingAttachments = [];

// ─── Text helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/[&<>"']/g,
    (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g,     '$1')
    .replace(/^#{1,6}\s+/gm,   '')
    .replace(/^[-*]\s+/gm,     '• ')
    .replace(/`(.+?)`/g,       '$1');
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
}

// ─── Bubble & UI helpers ──────────────────────────────────────────────────────

function pushBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble bubble--${role}`;
  div.innerHTML = linkify(escapeHtml(stripMarkdown(text)));
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function pushQuickReplies(options, { once = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-replies';
  for (const opt of options) {
    const b = document.createElement('button');
    b.className = 'quick-replies__btn';
    b.type = 'button';
    b.textContent = opt;
    b.onclick = () => { if (once) wrap.remove(); send(opt); };
    wrap.appendChild(b);
  }
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

function showTyping(on) {
  const existing = body.querySelector('.chat__typing');
  if (on) {
    if (existing) return;
    const t = document.createElement('div');
    t.className = 'chat__typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(t);
    body.scrollTop = body.scrollHeight;
  } else if (existing) {
    existing.remove();
  }
}

// ─── Attachment preview ───────────────────────────────────────────────────────

function renderPreviews() {
  previews.innerHTML = '';
  if (!pendingAttachments.length) return;
  for (const att of pendingAttachments) {
    const badge = document.createElement('div');
    badge.className = 'att-badge';
    if (att.type === 'image' && att.previewUrl) {
      badge.innerHTML = `<img class="att-thumb" src="${att.previewUrl}" alt="${escapeHtml(att.name)}" />`;
    } else {
      badge.innerHTML = `<span class="att-icon">${att.type === 'pdf' ? '📄' : '🎬'}</span>`;
    }
    const label = document.createElement('span');
    label.className = 'att-name';
    label.textContent = att.name.length > 16 ? att.name.slice(0, 14) + '…' : att.name;
    badge.appendChild(label);
    const rm = document.createElement('button');
    rm.className = 'att-remove'; rm.textContent = '×'; rm.title = 'Remove'; rm.type = 'button';
    rm.onclick = () => { pendingAttachments = pendingAttachments.filter((a) => a !== att); renderPreviews(); };
    badge.appendChild(rm);
    previews.appendChild(badge);
  }
}

function classifyFile(file) {
  if (file.type.startsWith('image/'))     return 'image';
  if (file.type === 'application/pdf')    return 'pdf';
  if (file.type.startsWith('video/'))     return 'video';
  return null;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const commaIdx = dataUrl.indexOf(',');
      const mediaType = dataUrl.slice(0, commaIdx).match(/:(.*?);/)?.[1] || file.type;
      resolve({ data: dataUrl.slice(commaIdx + 1), mediaType });
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  for (const file of files) {
    const type = classifyFile(file);
    if (!type) { pushBubble('system', `"${file.name}" is not supported. Please attach an image, PDF, or video only.`); continue; }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) { pushBubble('system', `"${file.name}" exceeds the ${MAX_FILE_SIZE_MB}MB limit.`); continue; }
    try {
      const { data, mediaType } = await readFileAsBase64(file);
      pendingAttachments.push({ type, mediaType, data, name: file.name, previewUrl: type === 'image' ? URL.createObjectURL(file) : null });
    } catch (e) { pushBubble('system', `Could not read "${file.name}": ${e.message}`); }
  }
  renderPreviews();
});

// ─── Turn-done handler ────────────────────────────────────────────────────────

function onTurnDone(meta) {
  showTyping(false);

  if (meta.ticketId) {
    const card = document.createElement('div');
    card.className = 'ticket-card';
    card.innerHTML = `Ticket raised: <strong>${escapeHtml(meta.ticketId)}</strong>. You will receive an SMS confirmation.`;
    body.appendChild(card);
    body.scrollTop = body.scrollHeight;
  }

  // Issue type buttons — for web-widget show after the very first greeting.
  // For in-app, show when the backend signals it (after charger selection).
  if (meta.showIssueTypes || (CHANNEL === 'web-widget' && firstBotMsg)) {
    pushQuickReplies(ISSUE_TYPES);
  }
  firstBotMsg = false;

  if (meta.showYesNo) pushQuickReplies(['Yes', 'No']);

  if (meta.closed) {
    sessionClosed = true;
    form.style.display = 'none';
    setTimeout(showRatingForm, 700);
  }
}

// ─── SSE streaming send ───────────────────────────────────────────────────────

async function send(message) {
  if (!sessionId || sessionClosed) return;

  let display = message;
  if (pendingAttachments.length) display += '\n' + pendingAttachments.map((a) => `📎 ${a.name}`).join('\n');
  pushBubble('user', display);

  input.value = '';
  sendBtn.disabled = true;
  showTyping(true);

  const toSend = pendingAttachments.map(({ type, mediaType, data, name }) => ({ type, mediaType, data, name }));
  pendingAttachments = [];
  renderPreviews();

  let botBubble = null;
  let botText   = '';

  try {
    const res = await fetch(`${API}/chat/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, attachments: toSend.length ? toSend : undefined }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    const handleLine = (line) => {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (currentEvent === 'text' && d.text) {
            showTyping(false);
            if (!botBubble) {
              botBubble = document.createElement('div');
              botBubble.className = 'bubble bubble--bot';
              body.appendChild(botBubble);
            }
            botText += d.text;
            botBubble.innerHTML = linkify(escapeHtml(stripMarkdown(botText)));
            body.scrollTop = body.scrollHeight;
          } else if (currentEvent === 'done') {
            onTurnDone(d);
          }
        } catch { /* ignore malformed SSE data lines */ }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach((l) => handleLine(l.trimEnd()));
    }
    if (buffer.trim()) handleLine(buffer.trim());

  } catch (e) {
    showTyping(false);
    pushBubble('system', `Couldn't reach SpinWise: ${e.message}`);
  } finally {
    sendBtn.disabled = false;
    if (!sessionClosed) input.focus();
  }
}

// ─── Rating form ──────────────────────────────────────────────────────────────

function showRatingForm() {
  const card = document.createElement('div');
  card.className = 'rating-card';
  card.innerHTML = `
    <p class="rating-card__title">How was your experience today?</p>
    <div class="rating-card__stars">
      ${[1,2,3,4,5].map((i) =>
        `<button type="button" class="star-btn" data-value="${i}" aria-label="${i} star">★</button>`
      ).join('')}
    </div>
    <textarea class="rating-card__feedback" placeholder="Any additional comments? (optional)" rows="2"></textarea>
    <button type="button" class="rating-card__submit" disabled>Submit</button>
  `;
  body.appendChild(card);
  body.scrollTop = body.scrollHeight;

  let selectedRating = 0;
  const stars     = card.querySelectorAll('.star-btn');
  const submitBtn = card.querySelector('.rating-card__submit');
  const feedbackEl = card.querySelector('.rating-card__feedback');

  const highlight = (n) => stars.forEach((s, i) => s.classList.toggle('star-btn--active', i < n));

  stars.forEach((btn) => {
    btn.addEventListener('mouseover', () => highlight(Number(btn.dataset.value)));
    btn.addEventListener('mouseout',  () => highlight(selectedRating));
    btn.addEventListener('click', () => {
      selectedRating = Number(btn.dataset.value);
      highlight(selectedRating);
      submitBtn.disabled = false;
    });
  });

  submitBtn.addEventListener('click', async () => {
    if (!selectedRating) return;
    const feedback = feedbackEl.value.trim();
    card.innerHTML = `<p class="rating-card__thanks">Thanks for your rating! ✓</p>`;
    try {
      const res  = await fetch(`${API}/chat/session/${sessionId}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: selectedRating, feedback }),
      });
      const data = await res.json();
      if (data.showAppRating) setTimeout(showAppStorePrompt, 500);
    } catch { /* rating save failed silently */ }
  });
}

// ─── App-store rating prompt ──────────────────────────────────────────────────

function showAppStorePrompt() {
  const card = document.createElement('div');
  card.className = 'appstore-card';
  card.innerHTML = `
    <p class="appstore-card__title">We're glad you had a great experience! 🎉</p>
    <p class="appstore-card__sub">Would you like to rate the Spin App on the store?</p>
    <div class="appstore-card__btns">
      <button type="button" class="appstore-btn appstore-btn--android">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M3.18 23.76a2 2 0 0 0 2.82.08l10-10.07L7 4.77 3.18 20.94a2 2 0 0 0 0 2.82z"/>
          <path d="M20.81 10.36l-3.35-1.93-3.9 3.93 3.9 3.92 3.38-1.95a2 2 0 0 0 0-3.97z"/>
          <path d="M1.85 1.07A2 2 0 0 0 1 2.82v18.36l9.09-9.13L1.85 1.07z"/>
          <path d="M17.46 3.66l-9-5.2a2 2 0 0 0-2.07.01L14.56 7.5l2.9-3.84z"/>
        </svg>
        Google Play
      </button>
      <button type="button" class="appstore-btn appstore-btn--ios">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
        </svg>
        App Store
      </button>
    </div>
    <button type="button" class="appstore-card__dismiss">Maybe later</button>
  `;
  body.appendChild(card);
  body.scrollTop = body.scrollHeight;

  function handleStoreRedirect() {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) {
      window.location.href = 'https://play.google.com/store/apps/details?id=com.exicom.android.spinev';
    } else if (/iphone|ipad|ipod/i.test(ua)) {
      window.location.href = 'https://apps.apple.com/in/app/spin-ev-charging-app/id1636262264';
    } else {
      window.location.href = 'https://www.exicom.com/';
    }
  }

  card.querySelector('.appstore-btn--android').addEventListener('click', handleStoreRedirect);
  card.querySelector('.appstore-btn--ios').addEventListener('click', handleStoreRedirect);
  card.querySelector('.appstore-card__dismiss').addEventListener('click', () => card.remove());
}

// ─── Form events ──────────────────────────────────────────────────────────────

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (msg || pendingAttachments.length) send(msg || '(attachment)');
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});

restartBtn.addEventListener('click', () => {
  body.innerHTML      = '';
  pendingAttachments  = [];
  sessionClosed       = false;
  firstBotMsg         = true;
  form.style.display  = '';
  renderPreviews();
  startSession();
});

// ─── Session ──────────────────────────────────────────────────────────────────

async function startSession() {
  try {
    const res  = await fetch(`${API}/chat/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel:              CHANNEL,
        prefillName:          cfg.prefillName,
        prefillMobile:        cfg.prefillMobile,
        prefillChargerSerial: cfg.prefillChargerSerial,
        prefillChargerModel:  cfg.prefillChargerModel,
      }),
    });
    const data = await res.json();
    sessionId  = data.sessionId;

    // Show charger picker immediately if multiple serials are pre-known (in-app)
    if (data.chargerOptions?.length > 1) {
      pushBubble('bot', 'Please select the charger you need help with:');
      pushQuickReplies(data.chargerOptions.map((c) => `${c.index}. ${c.description}`));
      firstBotMsg = false;
    }
  } catch (e) {
    pushBubble('system', `Could not start session: ${e.message}`);
    return;
  }

  await send('Hi');
}

startSession();
