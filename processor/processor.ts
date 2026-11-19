// Processor: tails data/events.ndjson from a saved byte offset -> dedupe -> identity resolution -> SQLite.
// Also serves the profile viewer (one process owns the DB).
import { DatabaseSync } from 'node:sqlite';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// events are untrusted-shaped JSON lines written by ingest
type Ev = Record<string, any>;

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      traits TEXT NOT NULL DEFAULT '{}', first_seen TEXT, last_seen TEXT, bot INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS identities (
      workspace_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, profile_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, kind, value));
    CREATE INDEX IF NOT EXISTS identities_profile ON identities(profile_id);
    CREATE TABLE IF NOT EXISTS events (
      workspace_id TEXT NOT NULL, message_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      source TEXT, type TEXT, event TEXT, name TEXT, anonymous_id TEXT, user_id TEXT,
      timestamp TEXT, received_at TEXT, properties TEXT,
      PRIMARY KEY (workspace_id, message_id));
    CREATE INDEX IF NOT EXISTS events_profile ON events(profile_id, timestamp);
  `);
  try { db.exec('ALTER TABLE profiles ADD COLUMN bot INTEGER NOT NULL DEFAULT 0'); } catch {} // DBs made before the column
  return db;
}

// ponytail: UA keywords + navigator.webdriver; scanners faking a normal Chrome without webdriver slip through
const BOT_UA = /bot|crawl|spider|slurp|headless|preview|scan|lighthouse|facebookexternalhit|whatsapp|skypeuripreview|bingpreview|python|curl|wget|httpclient|okhttp|phantom|puppeteer|playwright|selenium/i;
export const isBot = (e: Ev) => e.context?.webdriver === true || BOT_UA.test(String(e.context?.userAgent ?? ''));

export function createProcessor(db: DatabaseSync, log: (msg: string) => void = () => {}) {
  const q = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    seen: db.prepare('SELECT 1 FROM events WHERE workspace_id = ? AND message_id = ?'),
    owner: db.prepare('SELECT profile_id FROM identities WHERE workspace_id = ? AND kind = ? AND value = ?'),
    userOf: db.prepare("SELECT value FROM identities WHERE profile_id = ? AND kind = 'user'"),
    addIdentity: db.prepare('INSERT INTO identities (workspace_id, kind, value, profile_id) VALUES (?, ?, ?, ?)'),
    newProfile: db.prepare('INSERT INTO profiles (profile_id, workspace_id, first_seen, last_seen) VALUES (?, ?, ?, ?)'),
    touch: db.prepare(`UPDATE profiles SET first_seen = min(first_seen, :ts), last_seen = max(last_seen, :ts),
      bot = max(bot, :bot), traits = json_patch(traits, :traits) WHERE profile_id = :pid`),
    moveIdentities: db.prepare('UPDATE identities SET profile_id = ? WHERE profile_id = ?'),
    moveEvents: db.prepare('UPDATE events SET profile_id = ? WHERE profile_id = ?'),
    absorb: db.prepare(`UPDATE profiles SET
      traits = json_patch((SELECT traits FROM profiles WHERE profile_id = :from), traits),
      first_seen = min(first_seen, (SELECT first_seen FROM profiles WHERE profile_id = :from)),
      last_seen = max(last_seen, (SELECT last_seen FROM profiles WHERE profile_id = :from)),
      bot = max(bot, (SELECT bot FROM profiles WHERE profile_id = :from))
      WHERE profile_id = :to`),
    dropProfile: db.prepare('DELETE FROM profiles WHERE profile_id = ?'),
    insertEvent: db.prepare(`INSERT INTO events (workspace_id, message_id, profile_id, source, type, event, name,
      anonymous_id, user_id, timestamp, received_at, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };

  const userOf = (pid: string) => (q.userOf.get(pid) as { value: string } | undefined)?.value;
  const owner = (ws: string, kind: string, value: string) =>
    (q.owner.get(ws, kind, value) as { profile_id: string } | undefined)?.profile_id;
  // never fuse two different logged-in users (shared device, or login without logout)
  const canMerge = (a: string, b: string) => { const ua = userOf(a), ub = userOf(b); return !ua || !ub || ua === ub; };

  function merge(from: string, to: string) {
    q.moveIdentities.run(to, from);
    q.moveEvents.run(to, from);
    q.absorb.run({ from, to });
    q.dropProfile.run(from);
    log(`merge ${from} -> ${to}`);
  }

  function resolve(ws: string, e: Ev): string {
    // order matters: strongest id first, so a new user id claims the target before weaker ids are checked
    const ids: [string, string][] = [];
    if (e.userId) ids.push(['user', String(e.userId)]);
    if (typeof e.traits?.email === 'string') ids.push(['email', e.traits.email.trim().toLowerCase()]);
    ids.push(['anon', String(e.anonymousId)]);

    let target: string | undefined;
    for (const [kind, value] of ids) {
      const p = owner(ws, kind, value);
      if (!p) continue;
      if (e.userId && userOf(p) && userOf(p) !== String(e.userId)) continue; // belongs to someone else
      target = p;
      break;
    }
    if (!target) {
      target = 'p_' + randomUUID();
      q.newProfile.run(target, ws, e.timestamp, e.timestamp);
    }
    for (const [kind, value] of ids) {
      const p = owner(ws, kind, value);
      if (!p) q.addIdentity.run(ws, kind, value, target);
      else if (p !== target && canMerge(p, target)) merge(p, target);
    }
    return target;
  }

  function handle(e: Ev) {
    const ws = String(e.workspaceId ?? 'default');
    if (!e.messageId || !e.anonymousId) return;
    if (q.seen.get(ws, e.messageId)) return; // dedupe: SDK delivery is at-least-once
    const pid = resolve(ws, e);
    q.insertEvent.run(ws, e.messageId, pid, e.source ?? 'default', e.type, e.event ?? null, e.name ?? null,
      e.anonymousId, e.userId ?? null, e.timestamp, e.receivedAt ?? null,
      JSON.stringify(e.properties ?? e.traits ?? {}));
    q.touch.run({ pid, ts: e.timestamp, bot: isBot(e) ? 1 : 0, traits: JSON.stringify(e.type === 'identify' ? e.traits ?? {} : {}) });
  }

  // Reads only complete lines after the saved offset; offset and rows commit together, so a crash replays safely.
  // ponytail: reads the whole unread tail into memory; chunk it if the backlog ever gets to hundreds of MB
  function processFile(file: string): number {
    const key = 'offset:' + file;
    let offset = Number((q.getMeta.get(key) as { value: string } | undefined)?.value ?? 0);
    let fd: number;
    try { fd = openSync(file, 'r'); } catch { return 0; } // nothing ingested yet
    try {
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0; // file was replaced: replay, dedupe absorbs repeats
      if (size === offset) return 0;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) return 0; // only a partial line so far

      let n = 0;
      db.exec('BEGIN');
      try {
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let e: Ev;
          try { e = JSON.parse(line); } catch { log('skip unparsable line'); continue; }
          handle(e);
          n++;
        }
        q.setMeta.run(key, String(offset + end + 1));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return n;
    } finally {
      closeSync(fd);
    }
  }

  return { processFile, handle };
}

export function createViewer(db: DatabaseSync, viewerFile: string) {
  const list = db.prepare(`
    SELECT p.profile_id, p.workspace_id, p.traits, p.first_seen, p.last_seen, p.bot,
      (SELECT value FROM identities i WHERE i.profile_id = p.profile_id AND kind = 'user') AS user_id,
      COUNT(e.message_id) AS events,
      COUNT(CASE WHEN e.event = 'Order Completed' THEN 1 END) AS orders,
      COALESCE(SUM(CASE WHEN e.event = 'Order Completed' THEN json_extract(e.properties, '$.total') END), 0) AS total_spent,
      group_concat(DISTINCT e.source) AS sources
    FROM profiles p LEFT JOIN events e ON e.profile_id = p.profile_id
    GROUP BY p.profile_id ORDER BY p.last_seen DESC LIMIT 200`);
  const one = db.prepare('SELECT * FROM profiles WHERE profile_id = ?');
  const ids = db.prepare('SELECT kind, value FROM identities WHERE profile_id = ? ORDER BY kind');
  const evs = db.prepare(`SELECT timestamp, source, type, event, name, properties FROM events
    WHERE profile_id = ? ORDER BY timestamp DESC LIMIT 500`);

  return createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const path = req.url?.split('?')[0] ?? '/';
      if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(await readFile(viewerFile));
      }
      if (path === '/api/profiles') return json(200, list.all());
      const m = path.match(/^\/api\/profiles\/([\w-]+)$/);
      if (m) {
        const p = one.get(m[1]);
        if (!p) return json(404, { error: 'not found' });
        return json(200, { ...p, identities: ids.all(m[1]), events: evs.all(m[1]) });
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      console.error('[viewer]', err);
      return json(500, { error: 'internal' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.DATA_DIR ?? 'data';
  const inFile = process.env.IN_FILE ?? join(dataDir, 'events.ndjson');
  const dbFile = process.env.DB_FILE ?? join(dataDir, 'cdp.sqlite');
  const port = Number(process.env.VIEWER_PORT ?? 8788);
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = openDb(dbFile);
  const p = createProcessor(db, (msg) => console.log(`[processor] ${msg}`));

  // ponytail: 1s poll; fs.watch is flaky on Windows/network drives, and a bus consumer replaces this anyway
  const tick = () => {
    try {
      const n = p.processFile(inFile);
      if (n) console.log(`[processor] ${new Date().toISOString()} processed ${n} event(s)`);
    } catch (err) {
      console.error('[processor]', err);
    }
  };
  tick();
  setInterval(tick, 1000);
  createViewer(db, 'processor/viewer.html')
    .listen(port, () => console.log(`[processor] ${inFile} -> ${dbFile}, viewer http://localhost:${port}`));
}
