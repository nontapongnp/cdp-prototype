import { expect, test } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearBots, createProcessor, openDb, segments, toCsv } from './processor.ts';

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

test('clearBots removes anonymous bot profiles with their events, keeps people and logged-in profiles', () => {
  const { p, db, profiles } = setup();
  p.handle(ev({ anonymousId: 'scanner', context: { webdriver: true } }));
  p.handle(ev({ anonymousId: 'scanner', context: { webdriver: true } }));
  p.handle(ev({ anonymousId: 'person' }));
  p.handle(ev({ anonymousId: 'tester', userId: 'u1', context: { webdriver: true } })); // logged in = person
  expect(clearBots(db)).toBe(1);
  expect(profiles()).toHaveLength(2);
  expect((db.prepare("SELECT COUNT(*) c FROM events WHERE anonymous_id = 'scanner'").get() as { c: number }).c).toBe(0);
  expect(db.prepare("SELECT 1 FROM identities WHERE value = 'scanner'").get()).toBeUndefined();
});

test('segments: abandoners, high value, gaming interest, registered without order; anonymous bots excluded', () => {
  const { p, db } = setup();
  const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
  const now = new Date(Date.UTC(2026, 0, 1, 13, 0));
  const gaming = { category: 'Gaming', product_id: 'G1' };
  // a1: added 60 min ago, never ordered -> abandoner
  p.handle(ev({ anonymousId: 'a1', event: 'Product Added', timestamp: at(0), properties: gaming }));
  // a2: added then ordered 80k incl. Gaming -> high value, not abandoner, not gaming_interest
  p.handle(ev({ anonymousId: 'a2', userId: 'u2', event: 'Product Viewed', timestamp: at(0), properties: gaming }));
  p.handle(ev({ anonymousId: 'a2', userId: 'u2', event: 'Product Added', timestamp: at(1), properties: gaming }));
  p.handle(ev({ anonymousId: 'a2', userId: 'u2', event: 'Order Completed', timestamp: at(2), properties: { total: 80000, products: [gaming] } }));
  // a3: logged in, viewed Gaming, added 5 min ago (too recent to be abandoned)
  p.handle(ev({ anonymousId: 'a3', userId: 'u3', event: 'Product Viewed', timestamp: at(50), properties: gaming }));
  p.handle(ev({ anonymousId: 'a3', userId: 'u3', event: 'Product Added', timestamp: at(55), properties: gaming }));
  // bot: views Gaming, adds to cart -> excluded everywhere
  p.handle(ev({ anonymousId: 'bot', event: 'Product Added', timestamp: at(0), properties: gaming, context: { webdriver: true } }));

  const pid = (a: string) => (db.prepare("SELECT profile_id FROM identities WHERE kind = 'anon' AND value = ?").get(a) as { profile_id: string }).profile_id;
  const got = Object.fromEntries(segments(db, now).map((s) => [s.id, s.members.sort()]));
  expect(got).toEqual({
    cart_abandoners: [pid('a1')],
    high_value: [pid('a2')],
    gaming_interest: [pid('a3')],
    registered_no_order: [pid('a3')],
  });
});

test('toCsv: BOM, header, quoting, formula injection guard', () => {
  const csv = toCsv([
    { profile_id: 'p1', user_id: 'u1', traits: JSON.stringify({ name: '=HYPERLINK("x")', email: 'a@b.com' }), events: 3, orders: 1, total_spent: 990 },
    { profile_id: 'p2', traits: JSON.stringify({ name: 'สมชาย, ใจดี' }), events: 1, orders: 0, total_spent: 0 },
  ]);
  const [head, r1, r2] = csv.slice(1).trim().split('\r\n');
  expect(csv[0]).toBe('﻿');
  expect(head).toBe('profile_id,user_id,email,name,events,orders,total_spent,first_seen,last_seen,utm_source,utm_campaign');
  expect(r1).toBe(`p1,u1,a@b.com,"'=HYPERLINK(""x"")",3,1,990,,,,`);
  expect(r2).toBe('p2,,,"สมชาย, ใจดี",1,0,0,,,,');
});

test('campaign: stored per event; profile keeps first and last touch', () => {
  const { p, db } = setup();
  p.handle(ev({ anonymousId: 'a1', context: { campaign: { source: 'facebook', name: 'bts' } } }));
  p.handle(ev({ anonymousId: 'a1' }));
  p.handle(ev({ anonymousId: 'a1', userId: 'u1', context: { campaign: { source: 'line', name: 'retarget' } } }));
  const row = db.prepare(`SELECT
    (SELECT campaign FROM events WHERE campaign IS NOT NULL ORDER BY timestamp LIMIT 1) f,
    (SELECT campaign FROM events WHERE campaign IS NOT NULL ORDER BY timestamp DESC LIMIT 1) l,
    (SELECT COUNT(*) FROM events WHERE campaign IS NULL) n`).get() as { f: string; l: string; n: number };
  expect(JSON.parse(row.f)).toEqual({ source: 'facebook', name: 'bts' });
  expect(JSON.parse(row.l)).toEqual({ source: 'line', name: 'retarget' });
  expect(row.n).toBe(1);
});
