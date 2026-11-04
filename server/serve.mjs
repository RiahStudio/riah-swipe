#!/usr/bin/env node
/**
 * Riah Swipe — board server (zero dependencies, Node >= 18)
 *
 *   node server/serve.mjs [--root <dir>] [--port 8137] [--host 127.0.0.1]
 *
 * Serves, from one origin:
 *   /                     the board UI (board/)
 *   /decks/index.json     generated from <root>/decks/*.swipe.json (newest first)
 *   /decks/...            deck files + their media (images, audio, video)
 *   POST /api/swipe-results   the board's verdict sink -> <root>/data/{verdicts,results}/
 *   GET  /api/verdicts/:deck  verdicts stored for a deck
 *   POST /mcp             the MCP server over HTTP (optional bearer: SWIPE_MCP_TOKEN)
 *   GET  /health
 *
 * <root> holds decks/ (your content) and data/ (verdicts written here).
 * Binds to 127.0.0.1 by default. There is NO user auth on the board itself —
 * if you expose it beyond localhost, put it behind your own auth (see SECURITY.md).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  setRoot, getRoot, SAFE_ID, mcpHttpHandler, SERVER_INFO,
} from './swipe-mcp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOARD = path.resolve(HERE, '..', 'board')

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const PORT = Number(flag('--port', process.env.PORT || 8137))
const HOST = flag('--host', '127.0.0.1')
if (flag('--root', null)) setRoot(flag('--root', null))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/plain; charset=utf-8',
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** Serve a file from `base`, refusing anything that resolves outside it. */
async function serveFile(req, res, base, rel, { allow } = {}) {
  let p
  try { p = decodeURIComponent(rel) } catch { return send(res, 400, { error: 'bad path' }) }
  const file = path.resolve(base, '.' + path.posix.normalize('/' + p))
  if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, { error: 'forbidden' })
  if (allow && !allow(file)) return send(res, 403, { error: 'forbidden' })
  let st
  try { st = await fsp.stat(file) } catch { return send(res, 404, { error: 'not found' }) }
  if (st.isDirectory()) return serveFile(req, res, base, path.posix.join(p, 'index.html'), { allow })
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
    if (start > end || start >= st.size) { res.writeHead(416).end(); return }
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${st.size}` })
    return fs.createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

async function deckIndex() {
  const dir = path.join(getRoot(), 'decks')
  const rows = []
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.swipe.json')) continue
    const st = await fsp.stat(path.join(dir, f))
    rows.push({ file: f, mtime: st.mtimeMs })
  }
  rows.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file))
  return { batches: rows.map((r) => r.file) }
}

async function readBody(req, limit = 8_000_000) {
  let body = ''
  for await (const c of req) {
    body += c
    if (body.length > limit) throw Object.assign(new Error('payload too large'), { status: 413 })
  }
  return body
}

/** Persist a riah-swipe.results/1 payload as results file + merged verdicts. */
async function storeResults(payload) {
  if (!payload || payload.schema !== 'riah-swipe.results/1') {
    throw Object.assign(new Error('expected schema riah-swipe.results/1'), { status: 400 })
  }
  const id = String(payload.batchId || '')
  if (!SAFE_ID.test(id)) throw Object.assign(new Error('invalid batchId'), { status: 400 })
  if (!Array.isArray(payload.results)) throw Object.assign(new Error('results must be an array'), { status: 400 })
  const root = getRoot()
  await fsp.mkdir(path.join(root, 'data', 'results'), { recursive: true })
  await fsp.mkdir(path.join(root, 'data', 'verdicts'), { recursive: true })
  const writeAtomic = async (file, obj) => {
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2))
    await fsp.rename(tmp, file)
  }
  await writeAtomic(path.join(root, 'data', 'results', `${id}.results.json`), payload)
  const vfile = path.join(root, 'data', 'verdicts', `${id}.json`)
  let store = { schema: 'riah-swipe.verdicts/1', batchId: id, verdicts: [] }
  try { store = JSON.parse(await fsp.readFile(vfile, 'utf8')) } catch { /* new */ }
  const byCard = new Map((store.verdicts || []).map((v) => [v.cardId, v]))
  for (const r of payload.results) {
    if (!r || typeof r.cardId !== 'string' || !['keep', 'revise', 'discard'].includes(r.decision)) continue
    byCard.set(r.cardId, { cardId: r.cardId, decision: r.decision, note: r.note || '',
      decidedAt: r.decidedAt || new Date().toISOString(), via: 'board' })
  }
  store = { ...store, deckName: payload.deckName || store.deckName, project: payload.project || '',
    verdicts: [...byCard.values()], updatedAt: new Date().toISOString() }
  await writeAtomic(vfile, store)
  return { ok: true, batchId: id, decided: byCard.size }
}

const mcp = mcpHttpHandler(process.env.SWIPE_MCP_TOKEN || '')

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    // Block cross-site writes (CSRF / DNS-rebinding): a browser Origin must match Host.
    if (req.method === 'POST' && req.headers.origin) {
      let same = false
      try { same = new URL(req.headers.origin).host === req.headers.host } catch { /* bad origin */ }
      if (!same && p !== '/mcp') return send(res, 403, { error: 'cross-origin write blocked' })
    }
    if (p === '/health') return send(res, 200, { ok: true, ...SERVER_INFO, root: getRoot() })
    if (p === '/mcp') return mcp(req, res, url)
    if (req.method === 'POST' && p === '/api/swipe-results') {
      const payload = JSON.parse((await readBody(req)) || '{}')
      return send(res, 200, await storeResults(payload))
    }
    let m
    if (req.method === 'GET' && (m = /^\/api\/verdicts\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1])
      if (!SAFE_ID.test(id)) return send(res, 400, { error: 'invalid deck id' })
      try {
        return send(res, 200, JSON.parse(await fsp.readFile(path.join(getRoot(), 'data', 'verdicts', `${id}.json`), 'utf8')))
      } catch { return send(res, 404, { error: 'no verdicts for that deck' }) }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
    if (p === '/decks/index.json') return send(res, 200, await deckIndex())
    if (p.startsWith('/decks/')) {
      return serveFile(req, res, path.join(getRoot(), 'decks'), p.slice('/decks/'.length))
    }
    return serveFile(req, res, BOARD, p === '/' ? 'index.html' : p.slice(1))
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : 500)
    send(res, status, { error: status === 500 ? 'internal error' : e.message })
    if (status === 500) console.error(e)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Riah Swipe board  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`)
  console.log(`MCP endpoint      http://${HOST}:${PORT}/mcp${process.env.SWIPE_MCP_TOKEN ? '  (bearer token required)' : ''}`)
  console.log(`root              ${getRoot()}`)
})
