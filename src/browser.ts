// <script> build: replays calls the snippet queued before this file loaded, then swaps window.cdp for the real client.
import { createCdp } from './index';

const w = window as unknown as { cdp?: unknown[][] | ReturnType<typeof createCdp> };
const calls = Array.isArray(w.cdp) ? w.cdp : [];
const init = calls.find((c) => c[0] === 'init');

if (init) {
  const cdp = createCdp(init[1] as string, init[2] as Parameters<typeof createCdp>[1]);
  for (const [method, ...args] of calls) {
    const fn = (cdp as Record<string, unknown>)[method as string];
    if (typeof fn === 'function') fn(...args);
  }
  w.cdp = cdp;
} else {
  console.warn('[cdp] no init call found in snippet queue');
}
