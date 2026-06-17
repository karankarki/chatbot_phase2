import { useState } from 'react';

export default function ReviewPanel({ onSubmit, onRestart }) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    onSubmit({ rating, feedback });
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="review-panel">
        <div className="review-panel__thanks">
          <p>Thank you for your feedback!</p>
          <button onClick={onRestart}>Start a new chat</button>
        </div>
      </div>
    );
  }

  const display = hovered || rating;

  return (
    <div className="review-panel">
      <p className="review-panel__title">How was your experience?</p>
      <div className="review-panel__stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={`review-star${display >= n ? ' review-star--active' : ''}`}
            onClick={() => setRating(n)}
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(0)}
          >
            {n}
          </button>
        ))}
      </div>
      <textarea
        className="review-panel__feedback"
        placeholder="Share any feedback (optional)"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={2}
      />
      <div className="review-panel__actions">
        <button
          className="review-panel__submit"
          onClick={handleSubmit}
          disabled={rating === 0}
        >
          Submit
        </button>
        <button className="review-panel__skip" onClick={onRestart}>
          Skip
        </button>
      </div>
    </div>
  );
}
