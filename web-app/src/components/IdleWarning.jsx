import { useState, useEffect } from 'react';

export default function IdleWarning({ onStay, onClose }) {
  const [seconds, setSeconds] = useState(10);

  useEffect(() => {
    if (seconds <= 0) { onClose(); return; }
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds, onClose]);

  return (
    <div className="idle-warning">
      <div className="idle-warning__box">
        <p>Still there? Session will close in <strong>{seconds}s</strong></p>
        <button onClick={onStay}>I'm here</button>
      </div>
    </div>
  );
}
