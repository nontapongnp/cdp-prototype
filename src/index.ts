export type Props = Record<string, unknown>;

export interface CdpEvent {
  type: 'track' | 'identify' | 'page';
  event?: string;
  name?: string;
  properties?: Props;
  traits?: Props;
  anonymousId: string;
  userId?: string;
  messageId: string;
  timestamp: string;
  context: Props;
}

export interface Options {
  endpoint: string;
  flushAt?: number; // events per request
  flushInterval?: number; // ms
  maxQueue?: number;
  cookieDomain?: string; // e.g. ".example.com" to share anonymousId across subdomains
  consent?: boolean; // false = drop everything until setConsent(true) (PDPA)
}

const VERSION = '0.1.0';
const AID = 'cdp_aid';
const UID = 'cdp_uid';
const QUEUE = 'cdp_queue';

const ls = {
  get: (k: string) => {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set: (k: string, v: string | null) => {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode / blocked */ }
  },
};

const readCookie = (name: string) =>
  document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1] ?? null;

// Segment spec: ?utm_source=line&utm_campaign=bts -> context.campaign { source, name }.
// ponytail: only on pages whose URL has utm_*; carry it across a multi-page session (sessionStorage) if needed
const campaign = () => {
  const q = new URLSearchParams(location.search);
  const c: Props = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = q.get('utm_' + k);
    if (v) c[k === 'campaign' ? 'name' : k] = v.slice(0, 200);
  }
  return Object.keys(c).length ? c : undefined;
};

export function createCdp(writeKey: string, opts: Options) {
  const { endpoint, flushAt = 20, flushInterval = 5000, maxQueue = 1000, cookieDomain } = opts;
  let consent = opts.consent ?? true;
  let queue: CdpEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | undefined;

  try { queue = JSON.parse(ls.get(QUEUE) ?? '[]'); } catch { /* corrupt, start fresh */ }

  const save = () => ls.set(QUEUE, JSON.stringify(queue));
  const drop = (batch: CdpEvent[]) => { queue = queue.filter((e) => !batch.includes(e)); save(); };
  const schedule = () => { timer ??= setTimeout(flush, flushInterval); };
  const payload = (batch: CdpEvent[]) => JSON.stringify({ writeKey, sentAt: new Date().toISOString(), batch });

  function setAnonymousId(id: string) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const domain = cookieDomain ? `; domain=${cookieDomain}` : '';
    document.cookie = `${AID}=${id}; path=/; max-age=31536000; SameSite=Lax${domain}${secure}`;
    ls.set(AID, id);
    return id;
  }

  // `||` not `??`: an expired/blank cookie reads as "" and must not become the id
  const anonymousId = () => readCookie(AID) || ls.get(AID) || setAnonymousId(crypto.randomUUID());

  function enqueue(e: Pick<CdpEvent, 'type'> & Partial<CdpEvent>) {
    if (!consent) return;
    queue.push({
      ...e,
      anonymousId: anonymousId(),
      userId: e.userId ?? ls.get(UID) ?? undefined,
      messageId: crypto.randomUUID(), // backend dedupes on this (delivery is at-least-once)
      timestamp: new Date().toISOString(),
      context: {
        library: { name: 'cdp-web-sdk', version: VERSION },
        page: { url: location.href, path: location.pathname, title: document.title, referrer: document.referrer },
        userAgent: navigator.userAgent,
        locale: navigator.language,
        campaign: campaign(),
        webdriver: navigator.webdriver || undefined, // automated browser (link scanners, headless crawlers)
      },
    });
    if (queue.length > maxQueue) queue = queue.slice(-maxQueue); // ponytail: drop oldest when offline too long
    save();
    if (queue.length >= flushAt) void flush();
    else schedule();
  }

  // concurrent callers share the in-flight run, so `await flush()` always means "done sending"
  const flush = (): Promise<void> => (inflight ??= send().finally(() => { inflight = undefined; }));

  async function send() {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length) {
      const batch = queue.slice(0, flushAt);
      // text/plain = no CORS preflight, same as sendBeacon; backend must parse body as JSON
      const res = await fetch(endpoint, {
        method: 'POST', body: payload(batch), keepalive: true, headers: { 'Content-Type': 'text/plain' },
      }).catch(() => null);
      // ponytail: fixed-interval retry, add exponential backoff if the ingest API gets hammered
      if (!res || res.status === 429 || res.status >= 500) { schedule(); return; }
      drop(batch); // 2xx, or 4xx = bad payload that retrying won't fix
    }
  }

  // page closing: fetch may be killed, hand leftovers to the browser
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    while (queue.length) {
      const batch = queue.slice(0, flushAt);
      if (!navigator.sendBeacon?.(endpoint, payload(batch))) break;
      drop(batch);
    }
  });

  if (queue.length) schedule(); // leftovers from last visit

  return {
    track: (event: string, properties: Props = {}) => enqueue({ type: 'track', event, properties }),
    page: (name?: string, properties: Props = {}) => enqueue({ type: 'page', name, properties }),
    identify(userId: string, traits: Props = {}) {
      if (!consent) return;
      ls.set(UID, userId);
      enqueue({ type: 'identify', userId, traits });
    },
    reset() {
      ls.set(UID, null);
      setAnonymousId(crypto.randomUUID());
    },
    setConsent(v: boolean) {
      consent = v;
      if (!v) { queue = []; save(); }
    },
    flush,
  };
}

export type Cdp = ReturnType<typeof createCdp>;
