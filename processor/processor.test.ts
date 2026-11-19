import { expect, test } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessor, openDb } from './processor.ts';

let n = 0;
const ev = (o: Record<string, unknown>) => ({
  type: 'track', event: 'X', workspaceId: 'ws', source: 'shop', messageId: `m${++n}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...o,
});

function setup() {
  const db = openDb(':memory:');
  const p = createProcessor(db);
  const profiles = () => db.prepare('SELECT profile_id, traits FROM profiles').all() as { profile_id: string; traits: string }[];
  const eventsOf = (pid: string) => (db.prepare('SELECT COUNT(*) c FROM events WHERE profile_id = ?').get(pid) as { c: number }).c;
  return { db, p, profiles, eventsOf };
}

test('anonymous browsing then identify = one profile with all events and traits', () => {
  const { p, profiles, eventsOf } = setup();
  p.handle(ev({ anonymousId: 'a1' }));
  p.handle(ev({ anonymousId: 'a1' }));
  p.handle(ev({ type: 'identify', anonymousId: 'a1', userId: 'u1', traits: { name: 'Som', email: 'Som@X.com' } }));
  p.handle(ev({ anonymousId: 'a1', userId: 'u1' }));
  const all = profiles();
  expect(all).toHaveLength(1);
  expect(eventsOf(all[0].profile_id)).toBe(4);
  expect(JSON.parse(all[0].traits)).toEqual({ name: 'Som', email: 'Som@X.com' });
});

test('duplicate messageId is stored once', () => {
  const { p, db } = setup();
  const e = ev({ anonymousId: 'a1' });
  p.handle(e);
  p.handle(e);
  expect((db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c).toBe(1);
});

test('same user on two devices merges both histories', () => {
  const { p, profiles, eventsOf } = setup();
  p.handle(ev({ anonymousId: 'phone' }));
  p.handle(ev({ anonymousId: 'laptop' }));
  expect(profiles()).toHaveLength(2);
  p.handle(ev({ type: 'identify', anonymousId: 'phone', userId: 'u1', traits: {} }));
  p.handle(ev({ type: 'identify', anonymousId: 'laptop', userId: 'u1', traits: {} }));
  const all = profiles();
  expect(all).toHaveLength(1);
  expect(eventsOf(all[0].profile_id)).toBe(4);
});

test('shared device: a second user logging in does not swallow the first', () => {
  const { p, profiles } = setup();
  p.handle(ev({ type: 'identify', anonymousId: 'kiosk', userId: 'uA', traits: {} }));
  p.handle(ev({ type: 'identify', anonymousId: 'kiosk', userId: 'uB', traits: {} }));
  expect(profiles()).toHaveLength(2);
});

test('same email from two user ids does not merge them', () => {
  const { p, profiles } = setup();
  p.handle(ev({ type: 'identify', anonymousId: 'a1', userId: 'uA', traits: { email: 'x@y.com' } }));
  p.handle(ev({ type: 'identify', anonymousId: 'a2', userId: 'uB', traits: { email: 'x@y.com' } }));
  expect(profiles()).toHaveLength(2);
});

test('processFile resumes from offset and waits for complete lines', () => {
  const { p } = setup();
  const file = join(mkdtempSync(join(tmpdir(), 'proc-')), 'events.ndjson');
  const line = (o: object) => JSON.stringify(ev({ anonymousId: 'a1', ...o })) + '\n';
  const half = line({});
  writeFileSync(file, line({}) + line({}) + half.slice(0, 20)); // ingest mid-write
  expect(p.processFile(file)).toBe(2);
  appendFileSync(file, half.slice(20) + line({}));
  expect(p.processFile(file)).toBe(1 + 1);
  expect(p.processFile(file)).toBe(0);
});

test('bot flag: webdriver or crawler UA marks the profile, normal browser does not', () => {
  const { p, db } = setup();
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
  p.handle(ev({ anonymousId: 'scanner', context: { userAgent: chrome, webdriver: true } }));
  p.handle(ev({ anonymousId: 'crawler', context: { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }));
  p.handle(ev({ anonymousId: 'person', context: { userAgent: chrome } }));
  const bot = (a: string) => (db.prepare(
    "SELECT bot FROM profiles JOIN identities USING (profile_id) WHERE kind = 'anon' AND value = ?").get(a) as { bot: number }).bot;
  expect([bot('scanner'), bot('crawler'), bot('person')]).toEqual([1, 1, 0]);
});
