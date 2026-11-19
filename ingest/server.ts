// Ingest API: auth writeKey -> validate -> append to NDJSON -> 200.
// ponytail: NDJSON file stands in for the event bus; swap appendFile for a Kafka/SQS producer when the processor exists.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CdpEvent } from '../src/index.ts';

const MAX_BODY = 512 * 1024;
const MAX_BATCH = 100;
const TYPES = new Set(['track', 'identify', 'page']);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

export interface Config {
  writeKeys: Map<string, Source>;
  outFile: string;
  static?: Record<string, string>; // url path -> file (dev demo only)
}

export interface Source { workspaceId: string; source: string }

// "key:workspace:source,..." (source optional, defaults to "default")
// ponytail: env var registry; move to a DB table when keys are managed from a UI
export const parseWriteKeys = (s = 'dev:demo:shop,blog:demo:blog') =>
  new Map(s.split(',').map((p): [string, Source] => {
    const [key, workspaceId, source = 'default'] = p.trim().split(':');
    if (!key || !workspaceId) throw new Error(`WRITE_KEYS entry "${p}" must be key:workspace[:source]`);
    return [key, { workspaceId, source }];
  }));

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function isValidEvent(e: unknown): e is CdpEvent {
  const x = e as Partial<CdpEvent> | null;
  return (
    !!x && typeof x === 'object' &&
    TYPES.has(x.type as string) &&
    isStr(x.messageId) && isStr(x.anonymousId) &&
    typeof x.timestamp === 'string' && !Number.isNaN(Date.parse(x.timestamp)) &&
    (x.type !== 'track' || isStr(x.event))
  );
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createIngest(cfg: Config) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = performance.now();
    let ws = '-';
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
      if (req.method === 'POST') {
        // ponytail: plain console line; switch to a JSON logger (pino) when logs go to a collector
        const ms = Math.round(performance.now() - t0);
        console.log(`[ingest] ${new Date().toISOString()} ${code} ${ws} ${JSON.stringify(body ?? {})} ${ms}ms`);
      }
    };
    // SDK uses fetch mode "cors": without this header it can't read the status and would retry forever.
    // ponytail: open CORS, writeKey is public anyway; restrict to per-workspace origins later.
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      const path = req.url?.split('?')[0];
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return send(204);
      }
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && path && cfg.static?.[path]) {
        const file = cfg.static[path];
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        return res.end(await readFile(file));
      }
      if (req.method !== 'POST' || path !== '/v1/collect') return send(404, { error: 'not found' });

      const raw = await readBody(req);
      if (raw == null) return send(413, { error: 'body too large' });

      let body: { writeKey?: unknown; sentAt?: unknown; batch?: unknown };
      try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid json' }); }

      const src = cfg.writeKeys.get(body?.writeKey as string);
      if (!src) return send(401, { error: 'invalid writeKey' });
      ws = `${src.workspaceId}/${src.source}`;
      if (!Array.isArray(body.batch) || body.batch.length > MAX_BATCH) {
        return send(400, { error: `batch must be an array of at most ${MAX_BATCH}` });
      }

      // partial accept: one bad event shouldn't cost the good ones (SDK drops the whole batch on 4xx)
      const now = Date.now();
      const receivedAt = new Date(now).toISOString();
      // Device clocks lie. sentAt and timestamp come from the same clock, so shift by (server now - sentAt).
      // Latency adds a few ms of error; offline-queued events keep their real age.
      const sentAt = typeof body.sentAt === 'string' ? Date.parse(body.sentAt) : NaN;
      const skew = Number.isNaN(sentAt) ? 0 : now - sentAt;
      const ok = body.batch.filter(isValidEvent);
      const rejected = body.batch.length - ok.length;
      if (ok.length) {
        const lines = ok.map((e) => JSON.stringify({
          ...e,
          originalTimestamp: e.timestamp,
          timestamp: new Date(Date.parse(e.timestamp) + skew).toISOString(),
          ...src, // server fields last so the client can't spoof them
          receivedAt,
        }) + '\n');
        await appendFile(cfg.outFile, lines.join(''));
      }
      return send(200, { accepted: ok.length, rejected });
    } catch (err) {
      console.error('[ingest]', err);
      return send(500, { error: 'internal' }); // SDK keeps the batch and retries
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const outFile = process.env.OUT_FILE ?? 'data/events.ndjson';
  await mkdir(dirname(outFile), { recursive: true });
  createIngest({
    writeKeys: parseWriteKeys(process.env.WRITE_KEYS),
    outFile,
    static: { '/': 'demo/index.html', '/sdk.js': 'dist/browser.global.js' },
  }).listen(port, () => console.log(`[ingest] http://localhost:${port}  ->  ${outFile}`));
}
