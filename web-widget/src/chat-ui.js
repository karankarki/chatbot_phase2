/**
 * SpinWise chat UI — vanilla JS, no framework.
 */

const cfg = window.SpinWiseConfig || {};
const API = (cfg.apiBaseUrl || '/api').replace(/\/$/, '');
const CHANNEL = cfg.channel || 'web-widget';
const MAX_FILE_SIZE_MB = 10;
const ALLOWED_TYPES = ['image/jpeg','image/png','image/gif','image/webp','application/pdf',
  'video/mp4','video/quicktime','video/x-msvideo','video/webm'];

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
    <button class="chat__attach" id="sw-restart" title="Start over" style="background:transparent;border-color:rgba(255,255,255,0.18);color:rgba(255,255,255,0.85)">↻</button>
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

const body      = root.querySelector('#sw-body');
const previews  = root.querySelector('#sw-previews');
const form      = root.querySelector('#sw-form');
const input     = root.querySelector('#sw-input');
const sendBtn   = root.querySelector('#sw-send');
const restartBtn = root.querySelector('#sw-restart');
const fileInput = root.querySelector('#sw-file');

let sessionId = null;
let pendingAttachments = []; // [{ type, mediaType, data, name, previewUrl? }]

// ─── Text helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/`(.+?)`/g, '$1');
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s]+)/g,
    (url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
}

// ─── Bubble rendering ─────────────────────────────────────────────────────────

function pushBubble(role, text, opts = {}) {
  const div = document.createElement('div');
  div.className = `bubble bubble--${role}`;
  div.innerHTML = linkify(escapeHtml(stripMarkdown(text)));
  body.appendChild(div);
  if (opts.ticketId) {
    const card = document.createElement('div');
    card.className = 'ticket-card';
    card.innerHTML = `Ticket raised: <strong>${escapeHtml(opts.ticketId)}</strong>. You will receive an SMS confirmation.`;
    body.appendChild(card);
  }
  body.scrollTop = body.scrollHeight;
}

function pushQuickReplies(options) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-replies';
  for (const opt of options) {
    const b = document.createElement('button');
    b.className = 'quick-replies__btn';
    b.type = 'button';
    b.textContent = opt;
    b.onclick = () => { wrap.remove(); send(opt); };
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
      const icon = att.type === 'pdf' ? '📄' : '🎬';
      badge.innerHTML = `<span class="att-icon">${icon}</span>`;
    }

    const label = document.createElement('span');
    label.className = 'att-name';
    label.textContent = att.name.length > 16 ? att.name.slice(0, 14) + '…' : att.name;
    badge.appendChild(label);

    const rm = document.createElement('button');
    rm.className = 'att-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.type = 'button';
    rm.onclick = () => {
      pendingAttachments = pendingAttachments.filter((a) => a !== att);
      renderPreviews();
    };
    badge.appendChild(rm);
    previews.appendChild(badge);
  }
}

// ─── File reading ─────────────────────────────────────────────────────────────

function classifyFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, commaIdx);
      const data = dataUrl.slice(commaIdx + 1);
      const mediaType = meta.match(/:(.*?);/)?.[1] || file.type;
      resolve({ data, mediaType });
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
    if (!type) {
      pushBubble('system', `"${file.name}" is not supported. Please attach an image, PDF, or video only.`);
      continue;
    }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      pushBubble('system', `"${file.name}" exceeds the ${MAX_FILE_SIZE_MB}MB limit. Please compress or trim it.`);
      continue;
    }

    try {
      const { data, mediaType } = await readFileAsBase64(file);
      const previewUrl = type === 'image' ? URL.createObjectURL(file) : null;
      pendingAttachments.push({ type, mediaType, data, name: file.name, previewUrl });
    } catch (e) {
      pushBubble('system', `Could not read "${file.name}": ${e.message}`);
    }
  }

  renderPreviews();
});

// ─── Send ─────────────────────────────────────────────────────────────────────

async function send(message) {
  if (!sessionId) return;

  // Show user bubble with attachment indicators
  let display = message;
  if (pendingAttachments.length) {
    display += '\n' + pendingAttachments.map((a) => `📎 ${a.name}`).join('\n');
  }
  pushBubble('user', display);

  input.value = '';
  sendBtn.disabled = true;
  showTyping(true);

  const attachmentsToSend = pendingAttachments.map(({ type, mediaType, data, name }) => ({ type, mediaType, data, name }));
  pendingAttachments = [];
  renderPreviews();

  try {
    const res = await fetch(`${API}/chat/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, attachments: attachmentsToSend.length ? attachmentsToSend : undefined }),
    });
    const data = await res.json();
    showTyping(false);
    if (!res.ok || !data.reply) {
      throw new Error(data.message || `Server error ${res.status}`);
    }
    pushBubble('bot', data.reply, { ticketId: data.ticketId });

    if (/charger.*red light|colour.*led/i.test(data.reply)) {
      pushQuickReplies(['Red — steady', 'Red — blinking slow', 'Red — blinking fast', 'Yellow', 'Green blinking', 'No light']);
    }
  } catch (e) {
    showTyping(false);
    pushBubble('system', `Couldn't reach the SpinWise backend: ${e.message}`);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
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
  body.innerHTML = '';
  pendingAttachments = [];
  renderPreviews();
  startSession();
});

// ─── Session ──────────────────────────────────────────────────────────────────

async function startSession() {
  const res = await fetch(`${API}/chat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: CHANNEL,
      prefillName: cfg.prefillName,
      prefillMobile: cfg.prefillMobile,
      prefillChargerSerial: cfg.prefillChargerSerial,
      prefillChargerModel: cfg.prefillChargerModel,
    }),
  });
  const data = await res.json();
  sessionId = data.sessionId;
  await send('Hi');
}

startSession();
