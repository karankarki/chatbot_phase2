import { useState, useCallback, useRef, useEffect } from 'react';

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
  const [idleWarning, setIdleWarning]       = useState(false);
  const [showReview, setShowReview]         = useState(false);
  const [showYesNo, setShowYesNo]           = useState(false);
  const [showMcbImages, setShowMcbImages]   = useState(false);
  const [nocHandoffActive, setNocHandoffActive] = useState(false);

  const sessionId    = useRef(null);
  const idSeq        = useRef(0);
  const lastActivity = useRef(Date.now());
  const idleActive   = useRef(false);
  const nocTimerRef  = useRef(null);

  const nextId = () => ++idSeq.current;

  const pushMsg = (role, text, extra = {}) =>
    setMessages((prev) => [...prev, { id: nextId(), role, text, ts: Date.now(), ...extra }]);

  // ── Save open chat when user closes the browser/app tab ────────────────
  useEffect(() => {
    const handleUnload = () => {
      if (!sessionId.current || closed) return;
      const url = `${API}/chat/session/${sessionId.current}/save`;
      // sendBeacon fires reliably on page unload; JSON blob sets content-type
      navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' }));
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [closed]);

  // ── General idle timer: 2 min nudge, 3 min close ──────────────────────────
  const idleIntervalRef = useRef(null);
  useEffect(() => {
    if (idleIntervalRef.current) { clearInterval(idleIntervalRef.current); idleIntervalRef.current = null; }
    if (closed) return;
    idleIntervalRef.current = setInterval(async () => {
      if (closed || !sessionId.current) return;
      const silentMs = Date.now() - lastActivity.current;
      if (silentMs >= 600_000) {
        // 10 min — close with rating form
        clearInterval(idleIntervalRef.current);
        idleIntervalRef.current = null;
        idleActive.current = false;
        setIdleWarning(false);
        setClosed(true);
        setTimeout(() => setShowReview(true), 400);
      } else if (silentMs >= 300_000 && !idleActive.current) {
        // 5 min — fetch session to surface "Are you still there?" from backend
        try {
          const res = await fetch(`${API}/chat/session/${sessionId.current}`);
          if (res.ok) {
            const data = await res.json();
            const transcript = data.transcript ?? [];
            const lastMsg = transcript[transcript.length - 1];
            if (lastMsg?.role === 'assistant' && lastMsg.content.startsWith('Are you still there')) {
              pushMsg('bot', lastMsg.content);
              idleActive.current = true;
              setIdleWarning(true);
            }
          }
        } catch { /* ignore */ }
      }
    }, 30_000);
    return () => { if (idleIntervalRef.current) clearInterval(idleIntervalRef.current); };
  }, [closed]);

  // ── NOC handoff timer: show idle warning 2 minutes after NOC is triggered ──
  useEffect(() => {
    if (nocTimerRef.current) { clearTimeout(nocTimerRef.current); nocTimerRef.current = null; }
    if (nocHandoffActive && !closed) {
      nocTimerRef.current = setTimeout(() => {
        idleActive.current = true;
        setIdleWarning(true);
      }, 120_000);
    }
    return () => { if (nocTimerRef.current) clearTimeout(nocTimerRef.current); };
  }, [nocHandoffActive, closed]);

  const stayActive = useCallback(() => {
    lastActivity.current = Date.now();
    idleActive.current   = false;
    setIdleWarning(false);
  }, []);

  const closeFromIdle = useCallback(() => {
    idleActive.current = false;
    setIdleWarning(false);
    setClosed(true);
    setShowReview(true);
  }, []);

  const submitReview = useCallback(({ rating, feedback }) => {
    if (sessionId.current) {
      fetch(`${API}/chat/session/${sessionId.current}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, feedback }),
      }).catch(() => {});
    }
    setShowReview(false);
  }, []);
  // ───────────────────────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    const prefill = getSpinAppPrefill();
    const fromApp = !!prefill;
    setIsSpinApp(fromApp);

    setClosed(false);
    setChargerOptions([]);
    setShowIssueTypes(false);
    setInputHint(null);
    setIdleWarning(false);
    setShowReview(false);
    setShowYesNo(false);
    setShowMcbImages(false);
    setNocHandoffActive(false);
    lastActivity.current = Date.now();
    idleActive.current   = false;

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

    // Restore previous conversation if available (Spin App with history)
    if (data.restoredMessages?.length > 0) {
      const now = Date.now();
      const restoredMsgs = data.restoredMessages.map((m, i) => ({
        id: nextId(),
        role: m.role,
        text: m.text,
        ts: now - (data.restoredMessages.length - i) * 1000,
      }));
      setMessages([
        ...restoredMsgs,
        { id: nextId(), role: 'bot', text: 'Welcome back! Continuing from your previous conversation.', ts: now },
      ]);
    } else {
      // Build greeting based on what data is available
      const name = prefill?.name;
      const chargerCount = prefill?.serials?.length ?? 0;
      let greeting;
      if (name && chargerCount > 1) {
        greeting = `Hello ${name}! I'm SpinWise, Exicom's virtual assistant.\n\nI can see you have ${chargerCount} chargers registered. Please select which charger you need help with:`;
      } else if (name && chargerCount === 1) {
        greeting = `Hello ${name}! I'm SpinWise, Exicom's virtual assistant.\n\nI can see your charger details. Please select the issue you're facing:`;
      } else if (name) {
        greeting = `Hello ${name}! I'm SpinWise, Exicom's virtual assistant.\n\nPlease select the issue you're facing:`;
      } else {
        greeting = "Hello! Welcome to Exicom Customer Care.\n\nI'm SpinWise, Exicom's virtual assistant, here to help you get charging again quickly.\n\nPlease select the issue you're facing:";
      }
      setMessages([{ id: nextId(), role: 'bot', text: greeting, ts: Date.now() }]);
    }

    if (data.chargerOptions?.length > 0) setChargerOptions(data.chargerOptions);
    if (data.showIssueTypes) setShowIssueTypes(true);
  }, []);

  const sendMessage = useCallback(async (text, attachments = []) => {
    if (!sessionId.current || closed) return;

    // Reset idle timer on activity
    lastActivity.current = Date.now();
    idleActive.current   = false;
    setIdleWarning(false);

    // Hide quick-reply UI immediately
    setChargerOptions([]);
    setShowIssueTypes(false);
    setShowYesNo(false);
    setShowMcbImages(false);

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
        setMessages((prev) => [...prev, { id: botId, role: 'bot', text: chunk, ts: Date.now() }]);
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
            setShowYesNo(data.showYesNo ?? false);
            setShowMcbImages(data.showMcbImages ?? false);
            setNocHandoffActive(data.nocHandoffActive ?? false);
            if (data.closed) {
              setClosed(true);
              setTimeout(() => setShowReview(true), 400);
            }
          }
        }
      }
    } catch (e) {
      pushMsg('system', `Could not reach SpinWise: ${e.message}`);
    } finally {
      setTyping(false);
    }
  }, [closed]);

  return {
    messages, typing, closed,
    chargerOptions, showIssueTypes, inputHint, isSpinApp,
    idleWarning, showReview, showYesNo, showMcbImages, nocHandoffActive,
    startSession, sendMessage, stayActive, closeFromIdle, submitReview,
  };
}
