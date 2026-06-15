export default function AttachmentPreviews({ files, onRemove }) {
  if (!files.length) return null;

  return (
    <div className="att-previews">
      {files.map((f, i) => (
        <div key={i} className="att-badge">
          {f.type === 'image' ? (
            <img className="att-thumb" src={f.previewUrl} alt={f.name} />
          ) : (
            <span className="att-icon">{f.type === 'video' ? '🎬' : '📄'}</span>
          )}
          <span className="att-name">{f.name}</span>
          <button className="att-remove" onClick={() => onRemove(i)}>×</button>
        </div>
      ))}
    </div>
  );
}
