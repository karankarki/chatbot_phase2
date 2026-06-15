import { useState, useRef } from 'react';
import AttachmentPreviews from './AttachmentPreviews';

const ALLOWED_TYPES = ['image/', 'application/pdf', 'video/'];
const MAX_MB = 10;

function classifyFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      const mediaType = dataUrl.split(';')[0].split(':')[1];
      resolve({ base64, mediaType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ChatComposer({ onSend, disabled, maxLength }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);   // { type, mediaType, data, name, previewUrl }
  const fileRef = useRef(null);

  const handleFiles = async (fileList) => {
    const added = [];
    for (const file of Array.from(fileList)) {
      const kind = classifyFile(file);
      if (!kind) { alert(`${file.name}: only images, PDFs, and videos are allowed.`); continue; }
      if (file.size > MAX_MB * 1024 * 1024) { alert(`${file.name} exceeds ${MAX_MB} MB.`); continue; }
      const { base64, mediaType } = await readAsBase64(file);
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : null;
      added.push({ type: kind, mediaType, data: base64, name: file.name, previewUrl });
    }
    setFiles((prev) => [...prev, ...added]);
  };

  const removeFile = (i) => {
    setFiles((prev) => {
      const copy = [...prev];
      if (copy[i].previewUrl) URL.revokeObjectURL(copy[i].previewUrl);
      copy.splice(i, 1);
      return copy;
    });
  };

  const submit = () => {
    const msg = text.trim();
    if (!msg && !files.length) return;
    const attachments = files.map(({ previewUrl, ...rest }) => rest);
    onSend(msg || '(attachment)', attachments);
    setText('');
    setFiles([]);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="composer">
      <AttachmentPreviews files={files} onRemove={removeFile} />
      <div className="composer__row">
        <button
          className="composer__attach"
          onClick={() => fileRef.current?.click()}
          title="Attach file"
          disabled={disabled}
        >
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,video/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="composer__input-wrap">
          <textarea
            className="composer__input"
            rows={1}
            placeholder={
              maxLength === 10 ? 'Enter 10-digit mobile number'
              : maxLength === 15 ? 'Enter 15-character serial number'
              : 'Type a message…'
            }
            value={text}
            onChange={(e) => {
              let val = e.target.value;
              if (maxLength === 10) val = val.replace(/\D/g, '');        // digits only
              if (maxLength === 15) val = val.toUpperCase();              // serial: uppercase
              if (maxLength) val = val.slice(0, maxLength);              // hard cap
              setText(val);
            }}
            onKeyDown={handleKey}
            disabled={disabled}
            inputMode={maxLength === 10 ? 'numeric' : 'text'}
          />
          {maxLength && (
            <span className={`composer__counter${text.length === maxLength ? ' composer__counter--full' : ''}`}>
              {text.length}/{maxLength}
            </span>
          )}
        </div>
        <button
          className="composer__send"
          onClick={submit}
          disabled={disabled || (!text.trim() && !files.length)}
        >
          ➤
        </button>
      </div>
    </div>
  );
}
