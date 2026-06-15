# SpinWise — Web Widget

Two surfaces, one codebase:

| File          | Purpose                                                   |
|---------------|-----------------------------------------------------------|
| `index.html`  | Standalone chat page (`https://support.exicom-ps.com/chat`) |
| `widget.html` | Same UI, transparent shell, designed to load in an iframe |
| `embed.js`    | Drop-in script that creates a floating launcher + iframe  |

Everything lives in vanilla JS / CSS — no build step.

## Run locally

```bash
# In one terminal: start the backend (see ../backend)
cd ../backend && npm run start:dev

# In another: serve this folder
cd web-widget
python -m http.server 5173
# open http://localhost:5173/
```

The page reads its API base from `window.SPINWISE_API_BASE` (set inline in
`index.html`) or from the `?api=` query string on `widget.html`.

## Embed on the Exicom website

```html
<script
  src="https://support.exicom-ps.com/embed.js"
  data-api="https://chatbot-api.exicom-ps.com/api"
  data-widget="https://support.exicom-ps.com/widget.html"
  defer
></script>
```

This injects a floating launcher in the bottom-right; clicking it opens the
iframe with the chat. The iframe is fully isolated from the host page's CSS.
