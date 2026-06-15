const CATEGORIES = [
  'Charger problem',
  'Spin App help',
  'RFID card',
  'Status of an existing complaint',
  'Something else',
];

export default function QuickReplies({ onSelect }) {
  return (
    <div className="quick-replies">
      {CATEGORIES.map((cat) => (
        <button key={cat} className="quick-reply-btn" onClick={() => onSelect(cat)}>
          {cat}
        </button>
      ))}
    </div>
  );
}
