// Static demo bundle for Vercel: public/index.html (+ API url and write key baked in) and public/sdk.js.
// Usage: CDP_API_URL=https://xxx.up.railway.app CDP_WRITE_KEY=... node scripts/build-demo.ts  (after npm run build)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const api = process.env.CDP_API_URL?.replace(/\/+$/, '');
const key = process.env.CDP_WRITE_KEY;
if (!api || !key) {
  console.error('CDP_API_URL and CDP_WRITE_KEY must be set (Vercel → Settings → Environment Variables)');
  process.exit(1);
}
if (!/^https:\/\//.test(api)) {
  console.error('CDP_API_URL must be https:// (the SDK needs a secure context for crypto.randomUUID)');
  process.exit(1);
}

mkdirSync('public', { recursive: true });
const html = readFileSync('demo/index.html', 'utf8');
if (!html.includes('__CDP_API_URL__') || !html.includes('__CDP_WRITE_KEY__')) throw new Error('placeholders missing in demo/index.html');
writeFileSync('public/index.html', html.replace('__CDP_API_URL__', api).replace('__CDP_WRITE_KEY__', key));
copyFileSync('dist/browser.global.js', 'public/sdk.js');
console.log(`[build-demo] public/ -> ${api}/v1/collect`);
