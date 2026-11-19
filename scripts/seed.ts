// Seeds the running ingest with realistic journeys + edge cases, shaped exactly like the SDK sends them.
// Usage: npm run seed   (ingest must be running with the default WRITE_KEYS: dev=shop, blog=blog)
import { randomUUID } from 'node:crypto';

const ENDPOINT = process.env.ENDPOINT ?? 'http://localhost:8787/v1/collect';
const DAY = 86_400_000, MIN = 60_000;
// Story time starts 5 days ago; batches are *sent* now, like an SDK flushing an offline queue.
// So sentAt = real now (+ device skew), and ingest's clock correction keeps the historic timestamps.
let clock = Date.now() - 5 * DAY;
const later = (ms: number) => { clock += ms; };

type Ev = Record<string, unknown>;
const P = {
  // same ids/prices as demo/index.html
  AERO14: { product_id: 'NB-AERO14', name: 'Ncomp Aero 14', brand: 'Ncomp', category: 'Ultrabook', price: 38990 },
  STUDIO16: { product_id: 'NB-STUDIO16', name: 'Ncomp Studio 16', brand: 'Ncomp', category: 'Creator', price: 72990 },
  MOUSE: { product_id: 'AC-MOUSE', name: 'Ncomp Glide เมาส์ไร้สาย', brand: 'Ncomp', category: 'Accessory', price: 1290 },
  WORK14: { product_id: 'NB-WORK14', name: 'Ncomp Work 14', brand: 'Ncomp', category: 'Business', price: 26990 },
  VORTEX15: { product_id: 'NB-VORTEX15', name: 'Ncomp Vortex 15', brand: 'Ncomp', category: 'Gaming', price: 42990 },
};
const item = (p: keyof typeof P, quantity = 1) => ({ ...P[p], quantity, currency: 'THB' });

// One browser on one site: own anonymousId, sticky userId, local queue, optional wrong clock.
function device(label: string, writeKey: string, ua: string, clockSkewMs = 0) {
  let anon = randomUUID();
  let userId: string | undefined;
  let queue: Ev[] = [];
  const host = writeKey === 'blog' ? 'blog.ncomp.test' : 'shop.ncomp.test';
  const push = (e: Ev) => {
    queue.push({
      ...e, anonymousId: anon, userId, messageId: randomUUID(),
      timestamp: new Date(clock + clockSkewMs).toISOString(),
      context: { library: { name: 'cdp-web-sdk', version: '0.1.0' }, userAgent: ua, locale: 'th-TH',
        page: { url: `https://${host}/`, path: '/', title: label, referrer: '' } },
    });
    later(20_000 + Math.random() * 40_000); // people take 20-60s per step
  };
  const d = {
    page: (name: string, properties: Ev = {}) => (push({ type: 'page', name, properties }), d),
    track: (event: string, properties: Ev = {}) => (push({ type: 'track', event, properties }), d),
    identify: (id: string, traits: Ev) => { userId = id; push({ type: 'identify', traits }); return d; },
    reset: () => { userId = undefined; anon = randomUUID(); return d; },
    async flush() {
      const batch = queue;
      queue = [];
      await send(writeKey, batch, Date.now() + clockSkewMs);
      return batch;
    },
  };
  return d;
}

async function send(writeKey: string, batch: Ev[], sentAtMs: number) {
  const res = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ writeKey, sentAt: new Date(sentAtMs).toISOString(), batch }),
  });
  return { status: res.status, body: await res.json() };
}

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0) Safari/604.1';

const cases: [string, string][] = [];
const story = (who: string, expect: string) => { cases.push([who, expect]); console.log(`\n▶ ${who}`); };

// 1. Happy path: anonymous browse -> login at checkout -> buy
story('สมชาย: ดูของแบบไม่ login แล้ว login ตอนจ่ายเงิน', '1 profile, events ก่อน login รวมอยู่ด้วย, 1 order ฿38,990');
{
  const pc = device('Ncomp', 'dev', DESKTOP);
  pc.page('Home').page('Product', { product_id: 'NB-AERO14' }).track('Product Viewed', item('AERO14'))
    .track('Product Added', item('AERO14')).page('Cart').track('Cart Viewed', { products: [item('AERO14')], value: 38990 })
    .page('Sign In').identify('u_somchai', { name: 'สมชาย', email: 'somchai@example.com' }).track('Signed In', { method: 'email' })
    .track('Checkout Started', { products: [item('AERO14')], value: 38990, currency: 'THB' })
    .track('Order Completed', { order_id: 'NC-1001', products: [item('AERO14')], total: 38990, currency: 'THB' })
    .page('Order Complete', { order_id: 'NC-1001' });
  await pc.flush();
}

// 2. Two devices + two sites, linked by login
later(2 * 3600_000);
story('สมหญิง: มือถือดูของ, โน้ตบุ๊กอ่าน blog แล้วซื้อ, ค่อย login บนมือถือทีหลัง', '1 profile, 3 anonymousId, sources shop+blog');
{
  const phone = device('Ncomp', 'dev', IPHONE);
  phone.page('Home').track('Products Searched', { query: 'OLED', results: 1 }).page('Product', { product_id: 'NB-STUDIO16' })
    .track('Product Viewed', item('STUDIO16'));
  await phone.flush();
  later(5 * 3600_000);
  const blog = device('Ncomp Blog', 'blog', DESKTOP);
  blog.page('Article', { slug: 'how-to-choose-creator-laptop' }).track('Article Read', { slug: 'how-to-choose-creator-laptop', read_percent: 85 })
    .identify('u_somying', { name: 'สมหญิง', email: 'somying@example.com' }).track('Newsletter Subscribed', { list: 'tech-news' });
  await blog.flush();
  const laptop = device('Ncomp', 'dev', DESKTOP);
  laptop.page('Home').track('Product Viewed', item('STUDIO16')).track('Product Viewed', item('MOUSE'))
    .track('Product Added', item('STUDIO16')).track('Product Added', item('MOUSE'))
    .page('Sign In').identify('u_somying', { name: 'สมหญิง', email: 'somying@example.com' }).track('Signed In', { method: 'email' })
    .track('Order Completed', { order_id: 'NC-1002', products: [item('STUDIO16'), item('MOUSE')], total: 74280, currency: 'THB' });
  await laptop.flush();
  later(DAY);
  phone.page('Sign In').identify('u_somying', { name: 'สมหญิง', email: 'somying@example.com', phone: '0812345678' })
    .track('Signed In', { method: 'email' });
  await phone.flush();
}

// 3. Never logs in, abandons cart, comes back next day
story('ผู้ใช้ไม่ระบุตัวตน (วิชัย): ใส่ตะกร้าแล้วทิ้ง กลับมาดูซ้ำวันถัดไป', '1 anonymous profile, ไม่มี order (กลุ่ม abandoned cart)');
{
  const d = device('Ncomp', 'dev', ANDROID);
  d.page('Home').track('Product Viewed', item('VORTEX15')).track('Product Added', item('VORTEX15')).page('Cart')
    .track('Cart Viewed', { products: [item('VORTEX15')], value: 42990 });
  await d.flush();
  later(DAY);
  d.page('Product', { product_id: 'NB-VORTEX15' }).track('Product Viewed', item('VORTEX15'));
  await d.flush();
}

// 4. Shared family iPad, nobody logs out
story('มานี + มานะ: iPad เครื่องเดียวกัน มานีไม่ logout แล้วมานะมาใช้ต่อ', '2 profiles แยกกัน; event ที่มานะทำก่อน login จะติดชื่อมานี (ข้อจำกัดที่ต้องรู้)');
{
  const ipad = device('Ncomp', 'dev', IPAD);
  ipad.page('Sign In').identify('u_manee', { name: 'มานี', email: 'manee@example.com' }).track('Signed In', { method: 'email' })
    .track('Product Viewed', item('MOUSE')).track('Product Added', item('MOUSE'))
    .track('Order Completed', { order_id: 'NC-1003', products: [item('MOUSE')], total: 1290, currency: 'THB' });
  await ipad.flush();
  later(3 * 3600_000);
  ipad.page('Home').track('Product Viewed', item('WORK14')) // actually มานะ, but SDK still holds u_manee
    .page('Sign In').identify('u_mana', { name: 'มานะ', email: 'mana@example.com' }).track('Signed In', { method: 'email' })
    .track('Product Added', item('WORK14'))
    .track('Order Completed', { order_id: 'NC-1004', products: [item('WORK14')], total: 26990, currency: 'THB' });
  await ipad.flush();
}

// 5. Logout -> browse anonymously -> login again
story('นภา: ซื้อแล้ว logout, เดินดูต่อแบบไม่ login, แล้ว login อีกรอบ', '1 profile, 2 anonymousId (reset ตอน logout แล้วถูกรวมกลับตอน login)');
{
  const d = device('Ncomp', 'dev', IPHONE);
  d.page('Sign In').identify('u_napa', { name: 'นภา', email: 'napa@example.com' }).track('Signed In', { method: 'email' })
    .track('Order Completed', { order_id: 'NC-1005', products: [item('AERO14')], total: 38990, currency: 'THB' })
    .track('Signed Out');
  await d.flush();
  d.reset();
  later(30 * MIN);
  d.page('Home').track('Product Viewed', item('STUDIO16'));
  await d.flush();
  later(DAY);
  d.page('Sign In').identify('u_napa', { name: 'นภา', email: 'napa@example.com' }).track('Signed In', { method: 'email' })
    .track('Product Added', item('STUDIO16'));
  await d.flush();
}

// 6. Same email on two accounts
story('ปิติ: มี 2 บัญชี (เก่า/ใหม่) ใช้อีเมลเดียวกัน', '2 profiles ไม่รวมกัน ต้องให้ business ตัดสินใจ');
{
  const old = device('Ncomp', 'dev', DESKTOP);
  old.identify('u_piti_2019', { name: 'ปิติ (บัญชีเก่า)', email: 'piti@example.com' })
    .track('Order Completed', { order_id: 'NC-0042', products: [item('VORTEX15')], total: 42990, currency: 'THB' });
  await old.flush();
  const now = device('Ncomp', 'dev', ANDROID);
  now.page('Sign In').identify('u_piti', { name: 'ปิติ', email: 'PITI@example.com ' }).track('Signed In', { method: 'email' });
  await now.flush();
}

// 7. Network retry: same batch delivered twice
story('เอก: เน็ตกระตุก SDK ส่ง batch เดิมซ้ำ', '1 anonymous profile, event ไม่ซ้ำ (dedupe ด้วย messageId)');
{
  const d = device('Ncomp', 'dev', ANDROID);
  d.page('Home').track('Product Viewed', item('AERO14'));
  const batch = await d.flush();
  console.log('resend', await send('dev', batch, Date.now()));
}

// 8. Offline queue + wrong device clock
story('ดาว: มือถือเวลาเร็วไป 2 ชม. และเล่นตอนออฟไลน์ ส่งทีหลัง', 'เวลาใน timeline ถูกแก้ด้วย sentAt, event ออฟไลน์ยังเป็นเวลาจริงที่เกิด');
{
  const d = device('Ncomp', 'dev', IPHONE, 2 * 3600_000);
  d.page('Home').track('Product Viewed', item('MOUSE')).track('Product Added', item('MOUSE')); // offline in BTS
  later(45 * MIN); // back online
  d.identify('u_dao', { name: 'ดาว', email: 'dao@example.com' }).track('Signed In', { method: 'email' });
  await d.flush();
}

// 9. Garbage
story('ข้อมูลเสีย: event ไม่ครบ, writeKey ผิด', 'ingest ปฏิเสธ ไม่เข้า processor');
{
  console.log('partial', await send('dev', [{ type: 'track', event: 'No Ids' }, { type: 'nonsense' }], Date.now()));
  console.log('bad key', await send('stolen-key', [{ type: 'track', event: 'X', messageId: 'x', anonymousId: 'x', timestamp: new Date().toISOString() }], Date.now()));
}

console.log('\nExpected:');
for (const [who, exp] of cases) console.log(`- ${who}\n    → ${exp}`);
