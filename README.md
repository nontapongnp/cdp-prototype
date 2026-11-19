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
