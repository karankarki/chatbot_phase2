import { useState, useCallback, useRef } from 'react';

const API = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

/** Read Spin App prefill from URL query params.
 *  Flutter WebView loads: ?source=spin-app&name=Rahul&mobile=7983749823&serial=D126...
 *  Returns null for normal web users. */
function getSpinAppPrefill() {
  const p = new URLSearchParams(window.location.search);
  if (p.get('source') !== 'spin-app') return null;
  // Support ?serial=A&serial=B (multiple params) or ?serial=A,B (comma-separated)
  const rawSerials = p.getAll('serial').flatMap((s) => s.split(',').map((x) => x.trim())).filter(Boolean);
  return {
    name:    p.get('name')   || undefined,
    mobile:  p.get('mobile') || undefined,
    serials: rawSerials.length > 0 ? rawSerials : undefined,
  };
}

export function useChat() {
  const [messages, setMessages]             = useState([]);
  const [typing, setTyping]                 = useState(false);
  const [closed, setClosed]                 = useState(false);
  const [chargerOptions, setChargerOptions] = useState([]);
  const [showIssueTypes, setShowIssueTypes] = useState(false);
  const [inputHint, setInputHint]           = useState(null); // 'mobile' | 'serial' | null
  const [isSpinApp, setIsSpinApp]           = useState(false);
  const sessionId = useRef(null);
  const idSeq     = useRef(0);

  const nextId = () => ++idSeq.current;

  const pushMsg = (role, text, extra = {}) =>
    setMessages((prev) => [...prev, { id: nextId(), role, text, ...extra }]);

  const startSession = useCallback(async () => {
    const prefill = getSpinAppPrefill();
    const fromApp = !!prefill;
    setIsSpinApp(fromApp);

    setClosed(false);
    setChargerOptions([]);
    setShowIssueTypes(false);
    setInputHint(null);

    const body = {
      channel: fromApp ? 'in-app' : 'web-widget',
      ...(prefill?.name    && { prefillName: prefill.name }),
      ...(prefill?.mobile  && { prefillMobile: prefill.mobile }),
      ...(prefill?.serials?.length === 1 && { prefillChargerSerial: prefill.serials[0] }),
      ...(prefill?.serials?.length > 1   && { prefillChargerSerials: prefill.serials }),
    };

    const res  = await fetch(`${API}/chat/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    sessionId.current = data.sessionId;

    // Build greeting based on what data is available
    const name = prefill?.name;
    const chargerCount = prefill?.serials?.length ?? 0;
    let greeting;
    if (name && chargerCount > 1) {
      greeting = `Hello ${name}! 👋 I'm SpinWise, Exicom's virtual assistant.\n\nI can see you have ${chargerCount} chargers registered. Please select which charger you need help with:`;
    } else if (name && chargerCount === 1) {
      greeting = `Hello ${name}! 👋 I'm SpinWise, Exicom's virtual assistant.\n\nI can see your charger details. Please select the issue you're facing:`;
    } else if (name) {
      greeting = `Hello ${name}! 👋 I'm SpinWise, Exicom's virtual assistant.\n\nPlease select the issue you're facing:`;
    } else {
      greeting = "Hello! 👋 Welcome to Exicom Customer Care.\n\nI'm SpinWise, Exicom's virtual assistant, here to help you get charging again quickly.\n\nPlease select the issue you're facing:";
    }

    setMessages([{ id: nextId(), role: 'bot', text: greeting }]);
    if (data.chargerOptions?.length > 0) setChargerOptions(data.chargerOptions);
    if (data.showIssueTypes) setShowIssueTypes(true);
  }, []);

  const sendMessage = useCallback(async (text, attachments = []) => {
    if (!sessionId.current || closed) return;

    // Hide quick-reply UI immediately
    setChargerOptions([]);
    setShowIssueTypes(false);

    // Show user bubble
    const display = attachments.length
      ? text + '\n' + attachments.map((a) => `📎 ${a.name}`).join('\n')
      : text;
    pushMsg('user', display);
    setTyping(true);

    // id for the bot message we'll grow as chunks arrive
    const botId = nextId();
    let botAdded = false;

    const appendChunk = (chunk) => {
      if (!botAdded) {
        setMessages((prev) => [...prev, { id: botId, role: 'bot', text: chunk }]);
        botAdded = true;
        setTyping(false); // hide typing dots once first text appears
      } else {
        setMessages((prev) =>
          prev.map((m) => m.id === botId ? { ...m, text: m.text + chunk } : m),
        );
      }
    };

    try {
      const res = await fetch(`${API}/chat/session/${sessionId.current}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          attachments: attachments.length ? attachments : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Error ${res.status}`);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.trim()) continue;
          const lines     = part.split('\n');
          const eventName = lines.find((l) => l.startsWith('event: '))?.slice(7).trim() ?? 'text';
          const dataLine  = lines.find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          let data;
          try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }

          if (eventName === 'text' && data.text) {
            appendChunk(data.text);
          } else if (eventName === 'done') {
            // Strip [END] sentinel if it leaked into the streamed text
            setMessages((prev) =>
              prev.map((m) =>
                m.id === botId
                  ? { ...m, text: m.text.replace(/\s*\[END\]\s*$/m, '').trimEnd(), ticketId: data.ticketId }
                  : m,
              ),
            );
            setChargerOptions(data.chargerOptions ?? []);
            setShowIssueTypes(data.showIssueTypes ?? false);
            setInputHint(data.inputHint ?? null);
            if (data.closed) setClosed(true);
          }
        }
      }
    } catch (e) {
      pushMsg('system', `Could not reach SpinWise: ${e.message}`);
    } finally {
      setTyping(false);
    }
  }, [closed]);

  return { messages, typing, closed, chargerOptions, showIssueTypes, inputHint, isSpinApp, startSession, sendMessage };
}
