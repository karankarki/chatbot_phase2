/**
 * SpinWise — floating-bubble embed.
 *
 * Drop into any page:
 *   <script src="https://support.exicom-ps.com/embed.js"
 *           data-api="https://chatbot-api.exicom-ps.com/api"
 *           data-widget="https://support.exicom-ps.com/widget.html"></script>
 *
 * Creates a floating launcher + iframe. The iframe loads widget.html which
 * mounts the same chat-ui.js used by the standalone page.
 */
(function () {
  const script = document.currentScript;
  const api = script?.dataset.api || 'http://localhost:4000/api';
  const widget = script?.dataset.widget || 'http://localhost:5173/widget.html';

  const launcher = document.createElement('button');
  launcher.className = 'spinwise-launcher';
  launcher.title = 'Chat with SpinWise';
  launcher.textContent = '💬';
  document.body.appendChild(launcher);

  let frame = null;
  let open = false;

  launcher.addEventListener('click', () => {
    open = !open;
    if (open) {
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'spinwise-frame';
        frame.src = `${widget}?api=${encodeURIComponent(api)}`;
        document.body.appendChild(frame);
      }
      frame.style.display = 'block';
      launcher.textContent = '×';
    } else {
      if (frame) frame.style.display = 'none';
      launcher.textContent = '💬';
    }
  });

  // Minimal launcher + frame styles in case the host page has no Spinwise CSS
  const style = document.createElement('style');
  style.textContent = `
    .spinwise-launcher { position: fixed; right: 18px; bottom: 18px; width: 56px; height: 56px; border-radius: 50%; background: #0f4d92; color: white; border: none; cursor: pointer; box-shadow: 0 8px 20px rgba(15, 77, 146, 0.35); z-index: 999998; font-size: 24px; }
    .spinwise-frame { position: fixed; right: 18px; bottom: 86px; width: min(380px, calc(100vw - 36px)); height: min(620px, calc(100vh - 120px)); border: none; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2); background: white; z-index: 999999; }
  `;
  document.head.appendChild(style);
})();
