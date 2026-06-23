import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import jsQR from 'jsqr';
import heic2any from 'heic2any';
import {
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
} from 'libphonenumber-js';
import AttachmentPreviews from './AttachmentPreviews';

const MAX_MB = 10;

// Partner portal primary markets — pinned at top of picker
const TOP_MARKETS = ['IN', 'AE', 'SA', 'SG', 'MY', 'NG', 'GB', 'US'];

function flagEmoji(code) {
  return [...code.toUpperCase()]
    .map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join('');
}

const displayNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); }
  catch { return null; }
})();

function countryName(code) {
  try { return displayNames?.of(code) || code; }
  catch { return code; }
}

function classifyFile(file) {
  const t = file.type.toLowerCase();
  if (t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(file.name)) return 'heic';
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('video/')) return 'video';
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
          // QR found — serial is the part after '#'
          const serial = result.data.split('#').pop()?.trim().toUpperCase();
          resolve(serial || null);
        } else {
          // No QR or no '#' — return null so the image is sent to the LLM to read as text
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
  const [files, setFiles] = useState([]);
  const fileRef = useRef(null);

  // Phone-specific state
  const [country, setCountry] = useState('IN');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const geoFetched = useRef(false);
  const phoneFieldRef = useRef(null);

  // Auto-detect country from IP once when mobile hint activates
  useEffect(() => {
    if (inputHint !== 'mobile' || geoFetched.current) return;
    geoFetched.current = true;
    fetch('/api/geo')
      .then(r => r.json())
      .then(d => { if (d.country) setCountry(d.country); })
      .catch(() => {});
  }, [inputHint]);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e) => {
      if (!phoneFieldRef.current?.contains(e.target)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  // Build sorted country list once
  const allCountries = useMemo(() =>
    getCountries()
      .map(code => ({ code, name: countryName(code), flag: flagEmoji(code), dial: getCountryCallingCode(code) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  []);

  const filteredCountries = useMemo(() => {
    const q = countrySearch.toLowerCase();
    if (!q) return allCountries;
    return allCountries.filter(c =>
      c.name.toLowerCase().includes(q) || ('+' + c.dial).includes(q)
    );
  }, [allCountries, countrySearch]);

  const topList = useMemo(() =>
    filteredCountries.filter(c => TOP_MARKETS.includes(c.code)),
  [filteredCountries]);

  const otherList = useMemo(() =>
    filteredCountries.filter(c => !TOP_MARKETS.includes(c.code)),
  [filteredCountries]);

  const dialCode = getCountryCallingCode(country);

  const isPhoneValid = inputHint === 'mobile' && text.length > 0 &&
    isValidPhoneNumber('+' + dialCode + text);

  const handleFiles = async (fileList) => {
    const added = [];
    for (let file of Array.from(fileList)) {
      let kind = classifyFile(file);

      if (kind === 'heic') {
        try {
          const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
          const blob = Array.isArray(result) ? result[0] : result;
          file = new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
          kind = 'image';
        } catch {
          alert(`Could not convert ${file.name}. Please convert it to JPEG manually.`);
          continue;
        }
      }

      if (!kind) { alert(`${file.name}: only images, PDFs, and videos are allowed.`); continue; }
      if (file.size > MAX_MB * 1024 * 1024) { alert(`${file.name} exceeds ${MAX_MB} MB.`); continue; }

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
    if (inputHint === 'mobile') {
      if (!isPhoneValid) return;
      onSend('+' + dialCode + text, []);
      setText('');
      return;
    }
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

  const selectCountry = useCallback((code) => {
    setCountry(code);
    setPickerOpen(false);
    setCountrySearch('');
    setText('');
  }, []);

  const canSend = disabled || (inputHint === 'mobile' ? !isPhoneValid : (!text.trim() && !files.length));

  return (
    <div className="composer">
      <AttachmentPreviews files={files} onRemove={removeFile} />
      <div className="composer__row">
        {inputHint !== 'mobile' && (
          <>
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
          </>
        )}

        <div className="composer__input-wrap">
          {inputHint === 'mobile' ? (
            <div className="composer__phone-field" ref={phoneFieldRef}>
              <button
                className="composer__country-chip"
                type="button"
                onClick={() => { setPickerOpen(o => !o); setCountrySearch(''); }}
                disabled={disabled}
              >
                <span className="composer__chip-flag">{flagEmoji(country)}</span>
                <span className="composer__chip-code">+{dialCode}</span>
                <svg
                  className={`composer__chip-chev${pickerOpen ? ' open' : ''}`}
                  width="10" height="6" viewBox="0 0 10 6" fill="none"
                >
                  <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.6"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              <div className="composer__vsep" />

              <input
                className="composer__phone-input"
                type="tel"
                inputMode="numeric"
                placeholder="Mobile number"
                value={text}
                onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 15))}
                onKeyDown={handleKey}
                disabled={disabled}
                autoComplete="tel-national"
              />

              {isPhoneValid && (
                <span className="composer__phone-valid">
                  <svg width="16" height="16" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="8" fill="#1AAB9B" />
                    <path d="M4.5 8L6.8 10.5L11.5 5.5" stroke="white" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </span>
              )}

              {pickerOpen && (
                <div className="composer__country-panel">
                  <div className="composer__country-search-row">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <circle cx="5.5" cy="5.5" r="4" stroke="#888" strokeWidth="1.2" />
                      <path d="M9 9L11 11" stroke="#888" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                    <input
                      type="text"
                      placeholder="Search country or code"
                      value={countrySearch}
                      onChange={(e) => setCountrySearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="composer__country-opts">
                    {!countrySearch && topList.length > 0 && (
                      <>
                        <div className="composer__country-group">Top markets</div>
                        {topList.map(c => (
                          <button
                            key={c.code}
                            className={`composer__country-opt${c.code === country ? ' selected' : ''}`}
                            type="button"
                            onClick={() => selectCountry(c.code)}
                          >
                            <span className="composer__opt-flag">{c.flag}</span>
                            <span className="composer__opt-name">{c.name}</span>
                            <span className="composer__opt-dial">+{c.dial}</span>
                          </button>
                        ))}
                        {otherList.length > 0 && (
                          <div className="composer__country-group">All countries</div>
                        )}
                      </>
                    )}
                    {(countrySearch ? filteredCountries : otherList).map(c => (
                      <button
                        key={c.code}
                        className={`composer__country-opt${c.code === country ? ' selected' : ''}`}
                        type="button"
                        onClick={() => selectCountry(c.code)}
                      >
                        <span className="composer__opt-flag">{c.flag}</span>
                        <span className="composer__opt-name">{c.name}</span>
                        <span className="composer__opt-dial">+{c.dial}</span>
                      </button>
                    ))}
                    {filteredCountries.length === 0 && (
                      <div className="composer__country-empty">No results</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
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
          )}
        </div>

        <button className="composer__send" onClick={submit} disabled={canSend}>
          ➤
        </button>
      </div>
    </div>
  );
}
