import { useState, useRef } from 'react';
import jsQR from 'jsqr';
import AttachmentPreviews from './AttachmentPreviews';

const HEIC_TYPES = new Set(['image/heic', 'image/heif']);
const MAX_MB = 10;

function classifyFile(file) {
  if (HEIC_TYPES.has(file.type.toLowerCase())) return 'heic';
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

// Scan image file for a QR code. Returns the serial number (part after '#') or null.
function scanQRCode(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(data, width, height);
        if (result?.data?.includes('#')) {
          const serial = result.data.split('#').pop()?.trim().toUpperCase();
          resolve(serial || null);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export default function ChatComposer({ onSend, disabled, inputHint }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);   // { type, mediaType, data, name, previewUrl }
  const fileRef = useRef(null);

  const handleFiles = async (fileList) => {
    const added = [];
    for (const file of Array.from(fileList)) {
      const kind = classifyFile(file);
      if (kind === 'heic') {
        alert(`${file.name} is in HEIC format (iPhone default). Please open the photo in your Photos app, tap Share → Save as JPEG, then attach the JPEG version.`);
        continue;
      }
      if (!kind) { alert(`${file.name}: only images, PDFs, and videos are allowed.`); continue; }
      if (file.size > MAX_MB * 1024 * 1024) { alert(`${file.name} exceeds ${MAX_MB} MB.`); continue; }

      // Try QR scan on images silently — pre-fill serial if found
      if (kind === 'image') {
        const serial = await scanQRCode(file);
        if (serial) setText(serial);
      }

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
    const previewUrls = files.map((f) => f.previewUrl ?? null);
    const attachments = files.map(({ previewUrl, ...rest }) => rest);
    onSend(msg, attachments, previewUrls);
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
              inputHint === 'mobile' ? 'Enter 10-digit mobile number'
              : inputHint === 'serial' ? 'Enter charger serial number'
              : 'Type a message…'
            }
            value={text}
            onChange={(e) => {
              let val = e.target.value;
              if (inputHint === 'mobile') val = val.replace(/\D/g, '').slice(0, 10);
              if (inputHint === 'serial') {
                // Uppercase only when input looks like a charger serial (alphanumeric, no spaces)
                // If the user types a sentence/message, keep it lowercase so it reads naturally
                val = /^[A-Z0-9]*$/i.test(val) ? val.toUpperCase() : val.toLowerCase();
              }
              setText(val);
            }}
            onKeyDown={handleKey}
            disabled={disabled}
            inputMode={inputHint === 'mobile' ? 'numeric' : 'text'}
          />
          {inputHint === 'mobile' && (
            <span className={`composer__counter${text.length === 10 ? ' composer__counter--full' : ''}`}>
              {text.length}/10
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
