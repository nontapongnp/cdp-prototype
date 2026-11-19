# cdp-web-sdk

## npm

```ts
import { createCdp } from 'cdp-web-sdk';

const cdp = createCdp('WRITE_KEY', { endpoint: 'https://ingest.example.com/v1/collect' });
cdp.page();
cdp.identify('u_123', { email: 'a@b.com' });
cdp.track('Order Completed', { total: 990 });
cdp.reset(); // on logout
```

## Script tag

```html
<script>
  window.cdp = window.cdp || [];
  ['init', 'track', 'page', 'identify', 'reset', 'setConsent'].forEach(function (m) {
    cdp[m] = function () { cdp.push([m].concat([].slice.call(arguments))); };
  });
  cdp.init('WRITE_KEY', { endpoint: 'https://ingest.example.com/v1/collect' });
  cdp.page();
</script>
<script async src="https://cdn.example.com/cdp/browser.global.js"></script>
```

## Backend contract

`POST {endpoint}` with `Content-Type: text/plain` (avoids CORS preflight; `sendBeacon` sends the same). Body is JSON:

```json
{ "writeKey": "...", "sentAt": "ISO", "batch": [CdpEvent, ...] }
```

- Delivery is at-least-once: dedupe on `messageId`.
- Return 2xx on success. 429/5xx = SDK retries later. Other 4xx = SDK drops the batch.
- Trust server time over `timestamp` if clocks matter (`sentAt` lets you correct skew).

## Dev

```
npm install
npm test
npm run build   # dist/index.js (ESM) + dist/browser.global.js (IIFE)
npm run dev     # build + ingest on http://localhost:8787 (demo page at /)
```

## Seed data

`npm run seed` (ingest running) sends 9 scripted journeys shaped like real SDK batches: anonymous → login, two devices + blog,
abandoned cart, shared iPad, logout/re-login, same email on two accounts, retried batch, offline + wrong device clock, garbage.
It prints what each case should produce in the profile viewer.

## Processor + profile viewer (POC)

```
npm run processor   # tails data/events.ndjson -> data/cdp.sqlite, viewer on http://localhost:8788
```

- Reads new complete lines every 1s from a saved byte offset (`meta` table); offset and rows commit in one transaction.
- Dedupe on `(workspace_id, message_id)`.
- Identity resolution: ids `user` > `email` (from identify traits) > `anon` map to one profile; profiles merge when an event links them.
  Two profiles with different `user` ids are never merged (shared device, same email on two accounts).
- Reprocess from scratch: stop it, delete `data/cdp.sqlite*`, start again.
- Env: `IN_FILE`, `DB_FILE`, `VIEWER_PORT`. Uses Node's built-in `node:sqlite`.

## Ingest API (POC)

`ingest/server.ts`, Node stdlib only. Env: `PORT` (8787), `WRITE_KEYS` (`dev:demo:shop`, format `key:workspace:source,...`, source optional → `default`), `OUT_FILE` (`data/events.ndjson`).

- `POST /v1/collect` → `200 { accepted, rejected }`; invalid events are dropped individually.
- `401` bad writeKey, `400` bad JSON / batch > 100, `413` body > 512KB, `500` write failed (SDK retries).
- Each stored line = event + `workspaceId` + `source` + `receivedAt` (server-set, can't be spoofed).
- One writeKey per website; same workspace = profiles can merge across those sites.
- Output is an NDJSON file standing in for the event bus. No dedupe here: the processor does that on `messageId`.

## Deploy

```
Vercel (static)                    Railway (1 service + volume at /data)
  index.html + sdk.js  ── POST ──▶   ingest :$PORT  /v1/collect, /health, /viewer (Basic auth)
  (Ncomp demo shop)                  processor (1s loop) + viewer on 127.0.0.1:8788
                                     /data/events.ndjson, /data/cdp.sqlite
```

Ingest and processor share files, so they run in one container (`npm start` → `scripts/start.ts`).
Split them once the NDJSON file is replaced by a real queue.

**Railway** (new project → deploy from GitHub repo; `railway.json` sets build/start/healthcheck)

1. Add a volume mounted at `/data`.
2. Variables:
   - `DATA_DIR=/data`
   - `WRITE_KEYS=<random-key>:demo:shop` (do not reuse `dev`; it is in the source code)
   - `VIEWER_PASSWORD=<long random string>` (viewer at `https://<app>.up.railway.app/viewer`, any username)
3. Settings → Networking → Generate domain. Check `https://<app>.up.railway.app/health`.

**Vercel** (import the same repo; `vercel.json` sets build/output)

1. Variables: `CDP_API_URL=https://<app>.up.railway.app`, `CDP_WRITE_KEY=<same random-key>`.
2. Deploy. The build fails fast if either variable is missing or the URL is not https.

Seed the deployed API: `ENDPOINT=https://<app>.up.railway.app/v1/collect npm run seed` (uses keys `dev`/`blog`,
so add them to `WRITE_KEYS` first if you want seeded data there).
