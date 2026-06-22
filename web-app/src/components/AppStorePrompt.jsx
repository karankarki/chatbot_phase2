const ua = navigator.userAgent;
const isIOS     = /iPhone|iPad|iPod/i.test(ua);
const isAndroid = /Android/i.test(ua);
const showAndroid = !isIOS;
const showIOS     = !isAndroid;

const ANDROID_NATIVE = 'market://search?q=spin+ev+charging&c=apps';
const ANDROID_WEB    = 'https://play.google.com/store/search?q=spin+ev+charging&c=apps&hl=en_IN';
const IOS_NATIVE     = 'itms-apps://itunes.apple.com/in/app/spin-ev-charging-app/id1636262264';
const IOS_WEB        = 'https://apps.apple.com/in/app/spin-ev-charging-app/id1636262264';

function openStore(nativeUrl, webFallback) {
  // When the native store app opens, the window loses focus — use that to
  // cancel the HTTPS fallback so it doesn't also open in a browser tab.
  const timer = setTimeout(() => window.open(webFallback, '_blank'), 1500);
  window.addEventListener('blur', () => clearTimeout(timer), { once: true });
  window.location.href = nativeUrl;
}

export default function AppStorePrompt({ onDismiss, onRestart }) {
  return (
    <div className="appstore-prompt">
      <p className="appstore-prompt__title">We're glad you had a great experience! 🎉</p>
      <p className="appstore-prompt__sub">Would you like to rate the Spin App on the store?</p>
      <div className="appstore-prompt__btns">
        {showAndroid && (
          <button
            className="appstore-btn appstore-btn--android"
            onClick={() => openStore(ANDROID_NATIVE, ANDROID_WEB)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3.18 23.76a2 2 0 0 0 2.82.08l10-10.07L7 4.77 3.18 20.94a2 2 0 0 0 0 2.82z"/>
              <path d="M20.81 10.36l-3.35-1.93-3.9 3.93 3.9 3.92 3.38-1.95a2 2 0 0 0 0-3.97z"/>
              <path d="M1.85 1.07A2 2 0 0 0 1 2.82v18.36l9.09-9.13L1.85 1.07z"/>
              <path d="M17.46 3.66l-9-5.2a2 2 0 0 0-2.07.01L14.56 7.5l2.9-3.84z"/>
            </svg>
            Google Play
          </button>
        )}
        {showIOS && (
          <button
            className="appstore-btn appstore-btn--ios"
            onClick={() => openStore(IOS_NATIVE, IOS_WEB)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            App Store
          </button>
        )}
      </div>
      <div className="appstore-prompt__footer">
        <button className="appstore-prompt__dismiss" onClick={onDismiss}>Maybe later</button>
        <button className="appstore-prompt__restart" onClick={onRestart}>Start a new chat</button>
      </div>
    </div>
  );
}
