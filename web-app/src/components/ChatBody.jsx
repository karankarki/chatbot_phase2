import { useEffect, useRef } from 'react';
import icon from '../assets/spinwise-icon.svg';
import LedPicker from './LedPicker';

function TicketCard({ ticketId }) {
  return (
    <div className="ticket-card">
      <div className="ticket-card__header">✅ Complaint Raised</div>
      <div className="ticket-card__body">
        <div className="ticket-card__row">
          <span className="ticket-card__icon">🎫</span>
          <span className="ticket-card__label">Ticket ID</span>
          <span className="ticket-card__value">{ticketId}</span>
        </div>
      </div>
    </div>
  );
}

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Bubble({ msg }) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';

  if (isSystem) {
    return <div className="bubble bubble--system">{msg.text}</div>;
  }

  const timeLabel = formatTime(msg.ts);

  const lines = msg.text ? msg.text.split('\n') : [];
  const previews = msg.imagePreviews ?? [];

  return (
    <div className={`bubble-row ${isUser ? 'bubble-row--user' : 'bubble-row--bot'}`}>
      {!isUser && <img src={icon} alt="" className="bubble__avatar" />}
      <div className={`bubble ${isUser ? 'bubble--user' : 'bubble--bot'}`}>
        {lines.length > 0 && (
          <span>
            {lines.map((line, i) => (
              <span key={i}>
                {line}
                {i < lines.length - 1 && <br />}
              </span>
            ))}
          </span>
        )}
        {previews.length > 0 && (
          <div className="bubble__image-previews">
            {previews.map((url, i) => (
              <img key={i} src={url} alt="attachment" className="bubble__image-thumb" />
            ))}
          </div>
        )}
        {msg.ticketId && <TicketCard ticketId={msg.ticketId} />}
        {timeLabel && <span className={`bubble__time ${isUser ? 'bubble__time--user' : 'bubble__time--bot'}`}>{timeLabel}</span>}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="bubble-row bubble-row--bot">
      <img src={icon} alt="" className="bubble__avatar" />
      <div className="bubble bubble--bot bubble--typing">
        <span /><span /><span />
      </div>
    </div>
  );
}

export default function ChatBody({ messages, typing, showLedPicker, onLedSelect }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing, showLedPicker]);

  // Hide typing dots once the first streamed chunk has arrived (last msg is bot)
  const lastIsBot = messages.length > 0 && messages[messages.length - 1].role === 'bot';

  return (
    <div className="chat-body">
      {messages.map((m) => <Bubble key={m.id} msg={m} />)}
      {typing && !lastIsBot && <TypingIndicator />}
      {showLedPicker && (
        <div className="led-picker-inline">
          <LedPicker model={showLedPicker} onSelect={onLedSelect} />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
