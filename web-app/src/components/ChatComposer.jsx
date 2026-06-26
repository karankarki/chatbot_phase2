import { useState, useEffect } from 'react';
import jsQR from 'jsqr';
import AttachmentPreviews from './AttachmentPreviews';

const COUNTRIES = [
  { code: 'IN', flag: '🇮🇳', name: 'India',        dial: '+91',  min: 10, max: 10 },
  { code: 'AE', flag: '🇦🇪', name: 'UAE',           dial: '+971', min:  9, max:  9 },
  { code: 'SA', flag: '🇸🇦', name: 'Saudi Arabia',  dial: '+966', min:  9, max:  9 },
  { code: 'QA', flag: '🇶🇦', name: 'Qatar',         dial: '+974', min:  8, max:  8 },
  { code: 'KW', flag: '🇰🇼', name: 'Kuwait',        dial: '+965', min:  8, max:  8 },
  { code: 'BH', flag: '🇧🇭', name: 'Bahrain',       dial: '+973', min:  8, max:  8 },
  { code: 'OM', flag: '🇴🇲', name: 'Oman',          dial: '+968', min:  8, max:  8 },
  { code: 'GB', flag: '🇬🇧', name: 'UK',            dial: '+44',  min: 10, max: 10 },
  { code: 'US', flag: '🇺🇸', name: 'USA',           dial: '+1',   min: 10, max: 10 },
  { code: 'CA', flag: '🇨🇦', name: 'Canada',        dial: '+1',   min: 10, max: 10 },
  { code: 'AU', flag: '🇦🇺', name: 'Australia',     dial: '+61',  min:  9, max:  9 },
  { code: 'SG', flag: '🇸🇬', name: 'Singapore',     dial: '+65',  min:  8, max:  8 },
  { code: 'MY', flag: '🇲🇾', name: 'Malaysia',      dial: '+60',  min:  9, max: 10 },
  { code: 'ID', flag: '🇮🇩', name: 'Indonesia',     dial: '+62',  min:  9, max: 12 },
  { code: 'PH', flag: '🇵🇭', name: 'Philippines',   dial: '+63',  min: 10, max: 10 },
  { code: 'TH', flag: '🇹🇭', name: 'Thailand',      dial: '+66',  min:  9, max:  9 },
  { code: 'DE', flag: '🇩🇪', name: 'Germany',       dial: '+49',  min: 10, max: 11 },
  { code: 'FR', flag: '🇫🇷', name: 'France',        dial: '+33',  min:  9, max:  9 },
  { code: 'PK', flag: '🇵🇰', name: 'Pakistan',      dial: '+92',  min: 10, max: 10 },
  { code: 'BD', flag: '🇧🇩', name: 'Bangladesh',    dial: '+880', min: 10, max: 10 },
  { code: 'LK', flag: '🇱🇰', name: 'Sri Lanka',     dial: '+94',  min:  9, max:  9 },
  { code: 'NP', flag: '🇳🇵', name: 'Nepal',         dial: '+977', min: 10, max: 10 },
  { code: 'ZA', flag: '🇿🇦', name: 'South Africa',  dial: '+27',  min:  9, max:  9 },
  { code: 'NG', flag: '🇳🇬', name: 'Nigeria',       dial: '+234', min: 10, max: 10 },
];

function getCountry(code) {
  return COUNTRIES.find(c => c.code === code) ?? COUNTRIES[0];
}

const HEIC_TYPES = new Set(['image/heic', 'image/heif']);
const MAX_MB = 10;

function classifyFile(file) {
  const mimeType = file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  // Fall back to extension when the browser/WebView omits the MIME type (common on Android WebViews)
  if (HEIC_TYPES.has(mimeType) || (!mimeType && (ext === 'heic' || ext === 'heif'))) return 'heic';
  if (mimeType.startsWith('image/') || (!mimeType && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext))) return 'image';
  if (mimeType === 'application/pdf' || (!mimeType && ext === 'pdf')) return 'pdf';
  if (mimeType.startsWith('video/') || (!mimeType && ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext))) return 'video';
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

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_PX = 1920;

// Compress an image file to under 2 MB using canvas resize + JPEG quality reduction.
// Non-image files are returned unchanged.
function compressImage(file) {
  if (!file.type.startsWith('image/') && file.type !== '') return Promise.resolve(file);
  if (file.size <= MAX_IMAGE_BYTES) return Promise.resolve(file);

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;

      // Resize so longest side ≤ MAX_PX
      if (w > MAX_PX || h > MAX_PX) {
        const ratio = Math.min(MAX_PX / w, MAX_PX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      // Reduce quality until under 2 MB
      let quality = 0.85;
      let dataUrl;
      do {
        dataUrl = canvas.toDataURL('image/jpeg', quality);
        quality -= 0.05;
      } while (dataUrl.length * 0.75 > MAX_IMAGE_BYTES && quality > 0.1);

      // Convert dataUrl back to a File
      const binary = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      const compressed = new File([arr], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
      resolve(compressed);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
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

export default function ChatComposer({ onSend, disabled, inputHint, detectedCountry, onCountryChange }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);   // { type, mediaType, data, name, previewUrl }
  const [selectedCountry, setSelectedCountry] = useState(() => getCountry(detectedCountry));

  // Sync when IP-detected country arrives after session start
  useEffect(() => {
    if (detectedCountry) setSelectedCountry(getCountry(detectedCountry));
  }, [detectedCountry]);

  const handleCountryChange = (e) => {
    const c = getCountry(e.target.value);
    setSelectedCountry(c);
    setText('');
    onCountryChange?.(c.code);
  };

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

      const processedFile = kind === 'image' ? await compressImage(file) : file;
      const { base64, mediaType } = await readAsBase64(processedFile);
      const previewUrl = kind === 'image' ? URL.createObjectURL(processedFile) : null;
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

  if (inputHint === 'mobile') {
    const full = text.length === selectedCountry.max;
    const valid = text.length >= selectedCountry.min && text.length <= selectedCountry.max;
    const lenLabel = selectedCountry.min === selectedCountry.max
      ? `${selectedCountry.max} digits`
      : `${selectedCountry.min}–${selectedCountry.max} digits`;
    return (
      <div className="composer">
        <div className="composer__row">
          <select
            className="phone-country-select"
            value={selectedCountry.code}
            onChange={handleCountryChange}
            disabled={disabled}
          >
            {COUNTRIES.map(c => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.dial}
              </option>
            ))}
          </select>
          <input
            className="phone-number-input"
            type="tel"
            inputMode="numeric"
            placeholder={lenLabel}
            value={text}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, selectedCountry.max);
              setText(val);
            }}
            onKeyDown={handleKey}
            disabled={disabled}
          />
          <button
            className="composer__send"
            onClick={submit}
            disabled={disabled || !valid}
          >
            ➤
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="composer">
      <AttachmentPreviews files={files} onRemove={removeFile} />
      <div className="composer__row">
        {/* label wrapper is the most reliable trigger for file inputs on iOS/Android WebViews */}
        <label
          className="composer__attach"
          title="Attach file"
          style={{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
        >
          📎
          <input
            type="file"
            accept="image/*,application/pdf,video/*"
            multiple
            style={{ display: 'none' }}
            disabled={disabled}
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
        <div className="composer__input-wrap">
          <textarea
            className="composer__input"
            rows={1}
            placeholder={
              inputHint === 'serial' ? 'Enter charger serial number'
              : 'Type a message…'
            }
            value={text}
            onChange={(e) => {
              let val = e.target.value;
              if (inputHint === 'serial') {
                val = /^[A-Z0-9]*$/i.test(val) ? val.toUpperCase() : val.toLowerCase();
              }
              setText(val);
            }}
            onKeyDown={handleKey}
            disabled={disabled}
          />
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
