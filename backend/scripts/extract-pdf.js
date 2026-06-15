const fs = require('node:fs');
const { PDFParse } = require('pdf-parse');
const path = process.argv[2];
if (!path) { console.error('usage: node extract-pdf.js <file.pdf>'); process.exit(1); }
(async () => {
  const data = fs.readFileSync(path);
  const parser = new PDFParse({ data });
  const out = await parser.getText();
  process.stdout.write(out.text ?? JSON.stringify(out).slice(0, 2000));
})().catch((e) => { console.error(e); process.exit(2); });
