#!/usr/bin/env node
/**
 * Riah Swipe — MCP server
 * ========================
 * Exposes a Swipe board (keep / revise / discard verdicts over generated
 * batches) as a Model Context Protocol server, so an assistant can browse
 * decks, read cards and RECORD verdicts. Zero dependencies (Node >= 18).
 *
 *   stdio (default)  node server/swipe-mcp.mjs --root <dir>
 *   http             SWIPE_MCP_TOKEN=... node server/swipe-mcp.mjs --http --port 8790
 *                    POST /mcp  (JSON-RPC, or SSE when the client asks)   GET /health
 *
 * The board server (server/serve.mjs) mounts the same handler at /mcp.
 *
 * CONTRACTS
 *   deck     <root>/decks/<id>.swipe.json  { decks:[{id,name,source,kind,note,
 *            selectingFor,returnTo}], cards:[{id,deckId,kind,title,preview,media,meta}] }
 *   verdict  { cardId, decision: 'keep'|'revise'|'discard', note, decidedAt }
 *   results  riah-swipe.results/1 — the payload the board POSTs to /api/swipe-results
 *
 * The verdict store is <root>/data/verdicts/<deck>.json — the same place the
 * board server writes, so verdicts recorded from chat and from the board share it.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVER_NAME = 'riah-swipe'
const SERVER_VERSION = '1.0.0'
const PROTOCOL_VERSION = '2025-06-18'
const DECISIONS = ['keep', 'revise', 'discard']

// ── roots ───────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..', 'examples', 'sample')

/** A swipe root is a directory containing decks/. Created if missing. */
export function pickRoot(explicit) {
  const root = path.resolve(explicit || process.env.SWIPE_ROOT || DEFAULT_ROOT)
  fs.mkdirSync(path.join(root, 'decks'), { recursive: true })
  return root
}

let ROOT = pickRoot()
export const getRoot = () => ROOT
export const setRoot = (r) => { ROOT = pickRoot(r) }
const decksDir = () => path.join(ROOT, 'decks')
const verdictsDir = () => path.join(ROOT, 'data', 'verdicts')

// ── data access ─────────────────────────────────────────────────────────────

export async function loadDecks() {
  const out = []
  let names = []
  try {
    names = (await fsp.readdir(decksDir())).filter((f) => f.endsWith('.swipe.json'))
  } catch {
    return out
  }
  for (const f of names.sort()) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(decksDir(), f), 'utf8'))
      const decks = j.decks || []
      const cards = j.cards || []
      for (const d of decks) {
        out.push({ ...d, _file: f, _cards: cards.filter((c) => (c.deckId || d.id) === d.id) })
      }
      if (!decks.length && cards.length) {
        // a cards-only file: group by deckId, deck meta minimal
        const ids = [...new Set(cards.map((c) => c.deckId).filter(Boolean))]
        for (const id of ids) {
          out.push({ id, name: id, source: '', kind: '', returnTo: '', _file: f,
                     _cards: cards.filter((c) => c.deckId === id) })
        }
      }
    } catch { /* a malformed deck must not kill the server */ }
  }
  return out
}

export async function loadVerdicts(deckId) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(verdictsDir(), `${deckId}.json`), 'utf8'))
    return Array.isArray(j.verdicts) ? j.verdicts : []
  } catch {
    return []
  }
}

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export async function saveVerdict(deck, cardId, decision, note, via = 'mcp') {
  if (!SAFE_ID.test(String(deck.id))) throw new Error('unsafe deck id')
  if (!DECISIONS.includes(decision)) {
    throw new Error(`decision must be one of ${DECISIONS.join(' | ')} (got ${decision})`)
  }
  const dir = verdictsDir()
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${deck.id}.json`)
  let store
  try {
    store = JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch {
    store = { schema: 'riah-swipe.verdicts/1', batchId: deck.id, deckName: deck.name,
              project: deck.source || '', department: deck.returnTo || deck.source || '',
              verdicts: [] }
  }
  if (!Array.isArray(store.verdicts)) store.verdicts = []
  const decidedAt = new Date().toISOString()
  const latest = store.verdicts.filter((v) => v.cardId !== cardId)
  // same "latest verdict per card wins" rule the board uses
  store.verdicts = [...latest, { cardId, decision, note: note || '',
                                 via, decidedAt }]
  store.updatedAt = decidedAt
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2))
  await fsp.rename(tmp, file)
  return { cardId, decision, note: note || '', decidedAt, path: file }
}

function tally(verdicts) {
  const c = { keep: 0, revise: 0, discard: 0 }
  for (const v of verdicts) if (c[v.decision] !== undefined) c[v.decision] += 1
  return c
}

export function latestPerCard(verdicts) {
  const m = new Map()
  for (const v of verdicts) {
    const prev = m.get(v.cardId)
    if (!prev || String(v.decidedAt) > String(prev.decidedAt)) m.set(v.cardId, v)
  }
  return m
}

async function deckSummary(d) {
  const v = await loadVerdicts(d.id)
  const counts = tally(v)
  const decided = latestPerCard(v).size
  return {
    id: d.id, name: d.name || d.id, project: d.source || '',
    department: d.returnTo || d.source || '', kind: d.kind || '',
    note: d.note || '', selectingFor: d.selectingFor || '',
    cards: d._cards.length, decided, remaining: Math.max(0, d._cards.length - decided),
    counts, file: d._file,
  }
}

function cardView(c, verdict) {
  const media = typeof c.media === 'string' ? c.media : (c.media && c.media.src) || ''
  return {
    id: c.id, deckId: c.deckId || '', kind: c.kind || 'text', title: c.title || '',
    preview: c.preview || '', media, mediaUrl: media && process.env.SWIPE_PUBLIC_URL
      ? `${process.env.SWIPE_PUBLIC_URL.replace(/\/$/, '')}/${media.replace(/^\.?\//, '')}` : media,
    meta: c.meta || null,
    verdict: verdict ? { decision: verdict.decision, note: verdict.note || '',
                         decidedAt: verdict.decidedAt, via: verdict.via || 'board' } : null,
  }
}

/** riah-swipe.results/1 — byte-for-byte the shape src/app.js builds. */
export function buildResults(deck, cards, verdicts, { partial = false } = {}) {
  const latest = latestPerCard(verdicts)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const results = []
  for (const [cardId, v] of latest) {
    const card = byId.get(cardId) || {}
    results.push({
      cardId,
      title: card.title || '',
      approved: v.decision === 'keep',
      revised: v.decision === 'revise',
      decision: v.decision,
      note: v.note || '',
      voiceNote: v.voiceNote || '',
      thumb: v.thumb || '',
      content: card.preview || '',
      meta: card.meta || null,
      media: typeof card.media === 'string' ? card.media : (card.media && card.media.src) || '',
      decidedAt: v.decidedAt,
    })
  }
  return {
    schema: 'riah-swipe.results/1',
    batchId: deck.id,
    deckName: deck.name || deck.id,
    project: deck.source || '',
    department: deck.returnTo || deck.source || '',
    kind: deck.kind || '',
    sentAt: new Date().toISOString(),
    partial: partial || undefined,
    decidedCount: results.length,
    cardCount: cards.length,
    results,
  }
}

async function boardSummary() {
  const decks = await loadDecks()
  const rows = []
  for (const d of decks) rows.push(await deckSummary(d))
  rows.sort((a, b) => (b.remaining - a.remaining) || a.id.localeCompare(b.id))
  return {
    root: ROOT,
    decks: rows.length,
    cards: rows.reduce((n, r) => n + r.cards, 0),
    awaiting_you: rows.reduce((n, r) => n + r.remaining, 0),
    list: rows,
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'swipe_board',
    description: 'The whole Swipe board at a glance: every deck with card count, how many are decided, how many are waiting for a verdict, and the keep/revise/discard tally.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'swipe_decks',
    description: 'List Swipe decks, optionally filtered by project name (e.g. "Launch"). Newest-waiting first.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'filter by project/source, case-insensitive substring' },
      only_undecided: { type: 'boolean', description: 'only decks with cards still waiting on a verdict' },
    }, additionalProperties: false },
  },
  {
    name: 'swipe_deck',
    description: 'Open one deck: its metadata plus every card (id, title, kind, media, and the recorded verdict if any).',
    inputSchema: { type: 'object', properties: {
      deck_id: { type: 'string' },
      undecided_only: { type: 'boolean', description: 'only cards still waiting on a verdict' },
    }, required: ['deck_id'], additionalProperties: false },
  },
  {
    name: 'swipe_next_card',
    description: 'The next card in a deck still waiting on a verdict — use this to walk a deck card by card with the reviewer.',
    inputSchema: { type: 'object', properties: { deck_id: { type: 'string' } },
                   required: ['deck_id'], additionalProperties: false },
  },
  {
    name: 'swipe_record_verdict',
    description: 'Record the reviewer\'s verdict on one card. Writes to the board\'s own verdict store. keep = approved · revise = partially right, needs another pass · discard = cut.',
    inputSchema: { type: 'object', properties: {
      deck_id: { type: 'string' },
      card_id: { type: 'string' },
      decision: { type: 'string', enum: DECISIONS },
      note: { type: 'string', description: 'optional verbatim note for the department' },
    }, required: ['deck_id', 'card_id', 'decision'], additionalProperties: false },
  },
  {
    name: 'swipe_results',
    description: 'Build the riah-swipe.results/1 payload for a deck (what the phone board POSTs to /api/swipe-results). Set file=true to also write it to <root>/data/results/<deck>.results.json for downstream consumers.',
    inputSchema: { type: 'object', properties: {
      deck_id: { type: 'string' },
      partial: { type: 'boolean', description: 'true = deck not fully decided yet (in-progress sync)' },
      file: { type: 'boolean', description: 'also write the payload to disk' },
    }, required: ['deck_id'], additionalProperties: false },
  },
]

async function callTool(name, args = {}) {
  if (name === 'swipe_board') return await boardSummary()

  if (name === 'swipe_decks') {
    const decks = await loadDecks()
    let rows = []
    for (const d of decks) rows.push(await deckSummary(d))
    if (args.project) {
      const q = String(args.project).toLowerCase()
      rows = rows.filter((r) => `${r.project} ${r.department} ${r.id} ${r.name}`
        .toLowerCase().includes(q))
    }
    if (args.only_undecided) rows = rows.filter((r) => r.remaining > 0)
    rows.sort((a, b) => (b.remaining - a.remaining) || a.id.localeCompare(b.id))
    return { count: rows.length, decks: rows }
  }

  const decks = await loadDecks()
  const deck = args.deck_id ? decks.find((d) => d.id === args.deck_id) : null
  if (name !== 'swipe_board' && !deck) {
    return { error: `no deck with id "${args.deck_id}"`,
             known_ids: decks.map((d) => d.id).slice(0, 40) }
  }
  const verdicts = await loadVerdicts(deck.id)
  const latest = latestPerCard(verdicts)

  if (name === 'swipe_deck') {
    let cards = deck._cards.map((c) => cardView(c, latest.get(c.id)))
    if (args.undecided_only) cards = cards.filter((c) => !c.verdict)
    return { deck: await deckSummary(deck), cards }
  }

  if (name === 'swipe_next_card') {
    const card = deck._cards.find((c) => !latest.get(c.id))
    if (!card) {
      return { done: true, deck: await deckSummary(deck),
               message: 'every card in this deck has a verdict' }
    }
    const idx = deck._cards.findIndex((c) => c.id === card.id)
    return { done: false, position: idx + 1, of: deck._cards.length,
             remaining: deck._cards.length - latestPerCard(verdicts).size,
             card: cardView(card, null) }
  }

  if (name === 'swipe_record_verdict') {
    const card = deck._cards.find((c) => c.id === args.card_id)
    if (!card) return { error: `no card "${args.card_id}" in deck "${deck.id}"`,
                        card_ids: deck._cards.map((c) => c.id) }
    const saved = await saveVerdict(deck, args.card_id, String(args.decision), args.note)
    const after = await loadVerdicts(deck.id)
    return { saved, deck: await deckSummary({ ...deck, _cards: deck._cards }),
             next: deck._cards.find((c) => !latestPerCard(after).get(c.id))?.id || null,
             counts: tally(after) }
  }

  if (name === 'swipe_results') {
    const payload = buildResults(deck, deck._cards, verdicts, { partial: !!args.partial })
    if (args.file) {
      if (!SAFE_ID.test(String(deck.id))) throw new Error('unsafe deck id')
      const dir = path.join(ROOT, 'data', 'results')
      await fsp.mkdir(dir, { recursive: true })
      const out = path.join(dir, `${deck.id}.results.json`)
      await fsp.writeFile(out, JSON.stringify(payload, null, 2))
      return { wrote: out, ...payload }
    }
    return payload
  }

  return { error: `unknown tool ${name}` }
}

export async function handleRequest(req) {
  const { id, method, params } = req || {}
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Riah Swipe board: browse decks, walk cards, record keep/revise/discard verdicts.',
      })
    case 'notifications/initialized':
    case 'initialized':
      return null
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments || {}
      try {
        const out = await callTool(name, args)
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
                       structuredContent: out, isError: false })
      } catch (e) {
        const out = { error: e.message }
        return reply({ content: [{ type: 'text', text: `error: ${e.message}` }],
                       structuredContent: out, isError: true })
      }
    }
    case 'ping':
      return reply({})
    default:
      return fail(-32601, `method not found: ${method}`)
  }
}

// ── transports ──────────────────────────────────────────────────────────────

async function stdioMain() {
  // A client that closes the pipe early (Ctrl-C, a host killing the server) must
  // not crash us with an unhandled EPIPE — seen in testing 2026-10-04.
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0)
    throw e
  })
  const rl = (await import('node:readline')).createInterface({ input: process.stdin })
  for await (const line of rl) {
    const t = line.trim()
    if (!t) continue
    let req
    try { req = JSON.parse(t) } catch { continue }
    const res = await handleRequest(req)
    if (res) process.stdout.write(JSON.stringify(res) + '\n')
  }
}

function httpMain(port, token) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION,
                                      root: ROOT, tools: TOOLS.length }))
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'POST /mcp (or GET /health)' }))
    }
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    if (token) {
      const auth = req.headers.authorization || ''
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') || '')
      if (given !== token) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'unauthorized' }))
      }
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid JSON' }))
    }
    const batch = Array.isArray(payload) ? payload : [payload]
    const out = []
    for (const one of batch) {
      const r = await handleRequest(one)
      if (r) out.push(r)
    }
    const wantsSse = String(req.headers.accept || '').includes('text/event-stream')
    if (wantsSse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
                           connection: 'keep-alive' })
      for (const r of out) res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`)
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(Array.isArray(payload) ? out : out[0] || {}))
  })
  server.listen(port, () => {
    console.log(`riah-swipe MCP on http://127.0.0.1:${port}/mcp  (root: ${ROOT}, tools: ${TOOLS.length})`)
  })
}

// ── main ────────────────────────────────────────────────────────────────────

export function mcpHttpHandler(token) {
  return async (req, res, url) => {
    if (token) {
      const auth = req.headers.authorization || ''
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (given !== token) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'unauthorized' }))
      }
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 2_000_000) { res.writeHead(413).end(); return }
    }
    let payload
    try { payload = JSON.parse(body || '{}') } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid JSON' }))
    }
    const batch = Array.isArray(payload) ? payload : [payload]
    const out = []
    for (const one of batch) {
      const r = await handleRequest(one)
      if (r) out.push(r)
    }
    if (String(req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const r of out) res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`)
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(Array.isArray(payload) ? out : out[0] || {}))
  }
}

export const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION, tools: TOOLS.length }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const flag = (n, d) => {
    const i = argv.indexOf(n)
    return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d
  }
  const rootArg = flag('--root', null)
  if (rootArg && typeof rootArg === 'string') setRoot(rootArg)

  if (flag('--http', false)) {
    const port = Number(flag('--port', 8790)) || 8790
    const host = typeof flag('--host', null) === 'string' ? flag('--host', null) : '127.0.0.1'
    const handler = mcpHttpHandler(process.env.SWIPE_MCP_TOKEN || '')
    http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ...SERVER_INFO, root: ROOT }))
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'POST /mcp (or GET /health)' }))
      }
      handler(req, res, url)
    }).listen(port, host, () =>
      console.log(`riah-swipe MCP on http://${host}:${port}/mcp  (root: ${ROOT}, tools: ${TOOLS.length})`))
  } else {
    stdioMain()
  }
}
