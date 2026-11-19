import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createIngest, parseWriteKeys } from './server.ts'

let url: string
let outFile: string
let live: ReturnType<typeof createIngest>

beforeAll(async () => {
  outFile = join(await mkdtemp(join(tmpdir(), 'ingest-')), 'events.ndjson')
  live = createIngest({ writeKeys: parseWriteKeys('k1:ws1:shop, k2:ws1'), outFile })
  await new Promise<void>((r) => live.listen(0, r))
  url = `http://localhost:${(live.address() as AddressInfo).port}`
})
afterAll(() => live.close())

const good = { type: 'track', event: 'A', messageId: 'm1', anonymousId: 'a1', timestamp: new Date().toISOString() }
const post = (body: unknown) =>
  fetch(`${url}/v1/collect`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

test('accepts valid events, rejects invalid ones, stamps workspace', async () => {
  const res = await post({
    writeKey: 'k1',
    batch: [good, { type: 'track' }, { ...good, workspaceId: 'spoof', source: 'spoof' }],
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(await res.json()).toEqual({ accepted: 2, rejected: 1 })

  const lines = (await readFile(outFile, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines).toHaveLength(2)
  expect(lines.every((l) => l.workspaceId === 'ws1' && l.source === 'shop' && l.receivedAt)).toBe(true)
})

test('source defaults when the key has none', async () => {
  await post({ writeKey: 'k2', batch: [{ ...good, messageId: 'm2' }] })
  const last = JSON.parse((await readFile(outFile, 'utf8')).trim().split('\n').pop()!)
  expect(last).toMatchObject({ messageId: 'm2', workspaceId: 'ws1', source: 'default' })
})

test('device clock 2h fast: timestamp corrected via sentAt, original kept', async () => {
  const fast = Date.now() + 2 * 3600_000
  const ts = new Date(fast - 60_000).toISOString() // event happened 1 min before send, on the fast clock
  await post({ writeKey: 'k1', sentAt: new Date(fast).toISOString(), batch: [{ ...good, messageId: 'm3', timestamp: ts }] })
  const last = JSON.parse((await readFile(outFile, 'utf8')).trim().split('\n').pop()!)
  expect(last.originalTimestamp).toBe(ts)
  expect(Math.abs(Date.parse(last.timestamp) - (Date.now() - 60_000))).toBeLessThan(5_000)
})

test('bad writeKey 401, bad json 400, oversized batch 400', async () => {
  expect((await post({ writeKey: 'nope', batch: [good] })).status).toBe(401)
  expect((await post('{not json')).status).toBe(400)
  expect((await post({ writeKey: 'k1', batch: Array(101).fill(good) })).status).toBe(400)
})
