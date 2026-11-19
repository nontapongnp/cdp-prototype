// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createCdp } from './index';

const sent = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).batch).flat();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  document.cookie = 'cdp_aid=; max-age=0; path=/';
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

test('batches at flushAt and attaches ids', async () => {
  const cdp = createCdp('key', { endpoint: '/e', flushAt: 2 });
  cdp.track('A');
  expect(fetchMock).not.toHaveBeenCalled();
  cdp.track('B');
  await cdp.flush();
  const [a, b] = sent();
  expect(a.event).toBe('A');
  expect(a.anonymousId).toBe(b.anonymousId);
  expect(a.messageId).not.toBe(b.messageId);
  expect(localStorage.getItem('cdp_queue')).toBe('[]');
});

test('identify sticks userId on later events, reset clears it', async () => {
  const cdp = createCdp('key', { endpoint: '/e' });
  cdp.identify('u1');
  cdp.track('A');
  const aid = document.cookie;
  cdp.reset();
  cdp.track('B');
  await cdp.flush();
  const [, a, b] = sent();
  expect(a.userId).toBe('u1');
  expect(b.userId).toBeUndefined();
  expect(document.cookie).not.toBe(aid);
});

test('5xx and network errors keep events, 4xx drops them', async () => {
  const cdp = createCdp('key', { endpoint: '/e' });
  cdp.track('A');
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  await cdp.flush();
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await cdp.flush();
  expect(JSON.parse(localStorage.getItem('cdp_queue')!)).toHaveLength(1);

  fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
  await cdp.flush();
  expect(localStorage.getItem('cdp_queue')).toBe('[]');
});

test('queue survives reload', async () => {
  createCdp('key', { endpoint: '/e' }).track('A');
  await createCdp('key', { endpoint: '/e' }).flush();
  expect(sent()[0].event).toBe('A');
});

test('no consent = nothing stored or sent', async () => {
  const cdp = createCdp('key', { endpoint: '/e', consent: false });
  cdp.identify('u1');
  cdp.track('A');
  await cdp.flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.cookie).not.toMatch(/cdp_aid=[^;]/);
  expect(localStorage.getItem('cdp_uid')).toBeNull();
});

test('utm params go to context.campaign (utm_campaign -> name), absent without them', async () => {
  history.replaceState(null, '', '/?utm_source=line&utm_medium=social&utm_campaign=bts2026&x=1');
  const cdp = createCdp('key', { endpoint: '/e' });
  cdp.page('Home');
  history.replaceState(null, '', '/');
  cdp.track('A');
  await cdp.flush();
  const [a, b] = sent();
  expect(a.context.campaign).toEqual({ source: 'line', medium: 'social', name: 'bts2026' });
  expect(b.context.campaign).toBeUndefined();
});
