import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
let proc, root

before(async () => {
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'swipe-test-'))
  fs.cpSync(path.join(REPO, 'examples/sample'), root, { recursive: true })
  proc = spawn('node', [path.join(REPO, 'server/serve.mjs'), '--root', root, '--port', String(PORT)], { stdio: 'pipe' })
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})
after(() => { proc?.kill(); fs.rmSync(root, { recursive: true, force: true }) })

const rpc = async (method, params) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return r.json()
}
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent

test('serves the board and deck manifest', async () => {
  const html = await (await fetch(`${BASE}/`)).text()
  assert.match(html, /Riah Swipe/)
  const idx = await (await fetch(`${BASE}/decks/index.json`)).json()
  assert.deepEqual(idx.batches.sort(), ['captain-mullet-shirts.swipe.json'])
  const img = await fetch(`${BASE}/decks/captain-mullet-shirts/power.webp`)
  assert.equal(img.status, 200)
})

test('blocks path traversal and cross-origin writes', async () => {
  const r = await fetch(`${BASE}/decks/..%2F..%2Fpackage.json`)
  assert.ok([403, 404].includes(r.status))
  const r2 = await fetch(`${BASE}/data/verdicts/x.json`)
  assert.equal(r2.status, 404)
  const r3 = await fetch(`${BASE}/api/swipe-results`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(r3.status, 403)
})

test('MCP: list tools, walk a deck, record a verdict', async () => {
  const list = await rpc('tools/list')
  assert.equal(list.result.tools.length, 6)
  const board = await tool('swipe_board', {})
  assert.equal(board.decks, 1)
  const next = await tool('swipe_next_card', { deck_id: 'captain-mullet-shirts' })
  assert.equal(next.card.id, 'cm-shirt-cardio')
  const rec = await tool('swipe_record_verdict', { deck_id: 'captain-mullet-shirts', card_id: 'cm-shirt-cardio', decision: 'keep', note: 'nice' })
  assert.equal(rec.counts.keep, 1)
  const bad = await rpc('tools/call', { name: 'swipe_record_verdict', arguments: { deck_id: 'captain-mullet-shirts', card_id: 'cm-shirt-calves', decision: 'maybe' } })
  assert.equal(bad.result.isError, true)
  const res = await tool('swipe_results', { deck_id: 'captain-mullet-shirts', file: true })
  assert.equal(res.schema, 'riah-swipe.results/1')
  assert.ok(fs.existsSync(path.join(root, 'data/results/captain-mullet-shirts.results.json')))
})

test('board results POST is stored and visible to MCP', async () => {
  const payload = { schema: 'riah-swipe.results/1', batchId: 'captain-mullet-shirts', deckName: 'x', results: [
    { cardId: 'cm-shirt-power', decision: 'keep', note: '', decidedAt: new Date().toISOString() }] }
  const r = await fetch(`${BASE}/api/swipe-results`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal(r.status, 200)
  const v = await (await fetch(`${BASE}/api/verdicts/captain-mullet-shirts`)).json()
  assert.equal(v.verdicts.find((x) => x.cardId === 'cm-shirt-power').via, 'board')
  const deck = await tool('swipe_deck', { deck_id: 'captain-mullet-shirts' })
  assert.equal(deck.deck.decided, 2) // cardio via MCP (previous test) + power via the board
  const evil = await fetch(`${BASE}/api/swipe-results`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, batchId: '../../evil' }) })
  assert.equal(evil.status, 400)
})
