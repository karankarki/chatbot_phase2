export default function ChargerPicker({ options, onSelect }) {
  if (!options || options.length === 0) return null;

  return (
    <div className="charger-picker">
      <p className="charger-picker__label">Select your charger:</p>
      <div className="charger-picker__list">
        {options.map((c) => (
          <button
            key={c.index}
            className="charger-option"
            onClick={() => onSelect(c.index)}
          >
            <span className="charger-option__num">{c.index}</span>
            <span className="charger-option__body">
              <span className="charger-option__desc">{c.description}</span>
              <span className="charger-option__serial">{c.serial}</span>
              <span className={`charger-option__warranty${c.warrantyStatus === 'Under Warranty' ? ' charger-option__warranty--active' : ''}`}>
                {c.warrantyStatus}
                {c.warrantyEndDate ? ` · ${c.warrantyEndDate}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
