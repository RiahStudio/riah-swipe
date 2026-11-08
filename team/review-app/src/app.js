// src/app.js
// Controller — wires the data layer (decks/cards/verdicts) to the view
// (deck picker + swipe surface) and to the server (results delivery, phone URL).
//
// Modes:
//   1. PICKER  → list of decks with remaining counts. Tap a deck → swipe mode.
//   2. SWIPE   → one deck's cards in the swipe surface. Back arrow → picker.
//
// This is the only place the data layer and the DOM meet. The swipe-view
// doesn't know what a deck is — it just renders the cards it's handed.

import { KIND, makeVerdict } from './data/model.js';
import {
  getAllDecks, getDeck, getCardsByDeck, getDecidedCardIds,
  putVerdict, getAllVerdicts, getVerdictsForDeck, deleteVerdictsForCard,
  getSentDeckIds, purgeDeckAfterSend, replayVerdictJournal,
} from './data/store.js';
import { createSwipeView, normalizeTranscript } from './swipe-view.js';
import { captureApprovedThumb } from './logic/approved-thumb.js';
import { loadBundledDecks } from './data/deck-loader.js';
import { BRAND } from './config.js';

// Card size (the swipe subject only — not browser zoom). Unlabeled slider.
const CARD_SIZE_KEY = 'rsw-card-size';
// Range set max raised 2026-08-13 once zoom actually
// pastes the frame (not just a taller empty box). DEFAULT stays at 1 (fit).
// At 0.4–3.0 the handle rests ~24% along: visibly movable both ways.
const CARD_SIZE_MIN = 0.4;   // was 0.7 — shrink a genuinely huge card right down
const CARD_SIZE_MAX = 3.0;   // was 2.5 — real zoom past the frame; room to go super big
const CARD_SIZE_DEFAULT = 1;
// Bumping this re-applies CARD_SIZE_DEFAULT once, so a size saved under an
// earlier build doesn't override the current default forever.
const CARD_SIZE_DEFAULT_V = '2026-08-25a';
const CARD_SIZE_V_KEY = 'rsw-card-size-default-v';

function clampCardSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return CARD_SIZE_DEFAULT;
  return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, v));
}

function readCardSize() {
  try {
    if (localStorage.getItem(CARD_SIZE_V_KEY) !== CARD_SIZE_DEFAULT_V) {
      localStorage.setItem(CARD_SIZE_V_KEY, CARD_SIZE_DEFAULT_V);
      localStorage.setItem(CARD_SIZE_KEY, String(CARD_SIZE_DEFAULT));
      return CARD_SIZE_DEFAULT;
    }
    const raw = parseFloat(localStorage.getItem(CARD_SIZE_KEY));
    if (Number.isFinite(raw)) return clampCardSize(raw);
  } catch { /* ignore */ }
  return CARD_SIZE_DEFAULT;
}

function measureCardBase() {
  const surface = document.getElementById('rs-surface');
  if (!surface || surface.hidden) return;
  const app = document.getElementById('rs-app');
  const header = app && app.querySelector('.rs-header');
  const note = surface.querySelector('.rs-note');
  const actions = surface.querySelector('.rs-actions');
  const status = document.getElementById('rs-status');
  const chromeH = (header ? header.offsetHeight : 0)
    + (note ? note.offsetHeight : 0)
    + (actions ? actions.offsetHeight : 0)
    + (status && !status.hidden ? status.offsetHeight : 0);
  const baseW = Math.max(160, window.innerWidth - 28);
  const baseH = Math.max(160, window.innerHeight - chromeH - 8);
  document.documentElement.style.setProperty('--rs-card-base-w', `${Math.round(baseW)}px`);
  document.documentElement.style.setProperty('--rs-card-base-h', `${Math.round(baseH)}px`);
}

function applyCardSize(size) {
  const next = clampCardSize(size);
  document.documentElement.style.setProperty('--rs-card-size', String(next));
  try { localStorage.setItem(CARD_SIZE_KEY, String(next)); } catch { /* ignore */ }
  document.querySelectorAll('[data-card-size]').forEach((el) => {
    if (el.value !== String(next)) el.value = String(next);
  });
  measureCardBase();
  requestAnimationFrame(() => requestAnimationFrame(measureCardBase));
  return next;
}

function wireCardSizeControls(root) {
  const sliders = [...(root || document).querySelectorAll('[data-card-size]')];
  if (!sliders.length) return;
  const size = readCardSize();
  sliders.forEach((slider) => {
    slider.min = String(CARD_SIZE_MIN);
    slider.max = String(CARD_SIZE_MAX);
    slider.step = '0.05';
    slider.value = String(size);
    if (slider.dataset.sizeWired === '1') return;
    slider.dataset.sizeWired = '1';
    const onInput = () => applyCardSize(slider.value);
    slider.addEventListener('input', onInput);
    slider.addEventListener('change', onInput);
  });
  applyCardSize(size);
}

function reviewChromeHtml({ backLabel = 'Back to decks' } = {}) {
  return `
    <button class="rs-back" type="button" aria-label="${esc(backLabel)}">←</button>
    <label class="rs-card-size" title="Size of the thing you're judging">
      <input type="range" class="rs-card-size-slider" data-card-size
             min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="0.05"
             aria-label="Card size" />
    </label>
  `;
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const pickerEl    = document.getElementById('rs-picker');
const surfaceEl   = document.getElementById('rs-surface');
const headerSubEl = document.getElementById('rs-header-sub');
const statusEl    = document.getElementById('rs-status');
const bannerEl    = document.getElementById('rs-banner');
const phoneBtn    = document.getElementById('rs-phone-btn');

// ── App state ───────────────────────────────────────────────────────────────
let view = null;
let currentDeck = null;
let mode = 'picker';
let pendingPersistence = Promise.resolve();
let retryLoggedThisOpen = false;
const DELIVERY_RETRY_STATUS = "Saved here — couldn't deliver yet, will retry.";
let pickerScroll = 0;          // remembered deck-list scroll, restored on Back
let navEpoch = 0;              // invalidate in-flight open after Back
let finishing = new Set();     // deck ids mid-finish — guards double delivery

function bumpNav() { return ++navEpoch; }
function isStale(epoch) { return epoch !== navEpoch; }

// ── Bootstrap ───────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error('Swipe bootstrap failed:', err);
  setStatus('Failed to load. Refresh to try again.', 'error');
});

async function init() {
  // Keep verdicts durable: ask the browser not to evict IndexedDB.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}

  applyCardSize(readCardSize());
  window.addEventListener('resize', measureCardBase);
  await renderPicker();
  monitorNetwork();

  if (phoneBtn) phoneBtn.addEventListener('click', togglePhonePanel);
  if (surfaceEl) {
    surfaceEl.addEventListener('error', showMissingMedia, true);
    const onMediaReady = (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.rs-card-media')) measureCardBase();
    };
    surfaceEl.addEventListener('load', onMediaReady, true);
    surfaceEl.addEventListener('loadeddata', onMediaReady, true);
  }

  // Android / browser back: stack already popped — restore UI only.
  // In-app ← uses replaceState (never history.back — Brave bounce).
  history.replaceState({ rsView: 'picker' }, '');
  window.addEventListener('popstate', () => {
    if (mode === 'swipe') exitSurface({ syncHistory: false });
  });

  // Background: import newly-published batches, refresh the picker in place —
  // but only while the user is still on the picker, so a late import never
  // yanks them out of a deck they've opened.
  loadBundledDecks()
    .then(() => { if (mode === 'picker') renderPicker(); })
    .catch((err) => console.warn('Deck auto-load skipped:', err));

  // Re-check for new decks when the tab regains focus (their agents publish
  // decks while the tab sits open — this is how those arrive without a refresh).
  window.addEventListener('focus', () => {
    loadBundledDecks()
      .then((r) => { if (r.loaded && mode === 'picker') renderPicker(); })
      .catch(() => {});
  });
}

// ── Phone panel ─────────────────────────────────────────────────────────────
async function togglePhonePanel() {
  const existing = document.getElementById('rs-phone-panel');
  if (existing) { existing.remove(); return; }
  let info = null;
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    if (res.ok) info = await res.json();
  } catch { /* offline is fine */ }
  const urls = (info && Array.isArray(info.lanUrls) ? info.lanUrls : []).filter(Boolean);
  const panel = document.createElement('div');
  panel.id = 'rs-phone-panel';
  panel.className = 'rs-phone-panel';
  panel.innerHTML = `
    <div class="rs-phone-inner">
      <h3>Swipe from your phone</h3>
      ${urls.length ? `
        <p>On the same wifi, open this in your phone's browser:</p>
        ${urls.map((u) => `<div class="rs-phone-url">${esc(u)}</div>`).join('')}
        <p class="rs-phone-note">Typed notes work everywhere; voice notes are a desktop thing for now.</p>
      ` : `
        <p>Couldn't detect a network address. Make sure this machine is on wifi/ethernet, then try again.</p>
      `}
      <button class="rs-phone-close" type="button">Close</button>
    </div>
  `;
  document.body.appendChild(panel);
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.remove(); });
  panel.querySelector('.rs-phone-close').addEventListener('click', () => panel.remove());
}

// ── Picker mode ─────────────────────────────────────────────────────────────
async function renderPicker() {
  mode = 'picker';
  if (view && view.destroy) {
    try { view.destroy(); } catch { /* ignore */ }
    view = null;
  }
  pickerEl.hidden = false;
  surfaceEl.hidden = true;
  headerSubEl.innerHTML = '';
  document.documentElement.style.removeProperty('--rs-accent');
  setTagline(BRAND.tagline);
  renderBanner();

  const [decks, decided, allVerdicts, sentIds] = await Promise.all([
    getAllDecks(),
    getDecidedCardIds(),
    getAllVerdicts(),
    getSentDeckIds(),
  ]);

  pickerEl.innerHTML = '';
  if (decks.length === 0) {
    renderEmpty(
      'No decks yet.',
      'Your tools drop review batches into the decks folder — they show up here. The Welcome deck should arrive on first run; refresh if it hasn’t.'
    );
    return;
  }

  const counts = new Map();
  for (const v of allVerdicts) {
    const c = counts.get(v.deckId) || { keep: 0, revise: 0, discard: 0 };
    c[v.decision] = (c[v.decision] || 0) + 1;
    counts.set(v.deckId, c);
  }

  const deckCards = await Promise.all(decks.map((d) => getCardsByDeck(d.id)));

  // The picker shows ONLY decks with cards left to swipe. A fully-decided deck
  // never lingers: its results are delivered and it drops off for good.
  const review = [];
  const finishedUndelivered = [];
  decks.forEach((deck, i) => {
    if (sentIds.has(deck.id)) return;
    const cards = deckCards[i];
    const total = cards.length;
    if (total === 0) return;
    const remaining = cards.filter((c) => !decided.has(c.id)).length;
    if (remaining === 0) { finishedUndelivered.push(deck); return; }
    review.push({
      deck,
      info: {
        total,
        remaining,
        done:    total - remaining,
        counts4: counts.get(deck.id) || { keep: 0, revise: 0, discard: 0 },
      },
    });
  });

  if (review.length) {
    const list = document.createElement('ul');
    list.className = 'rs-deck-list';
    review.forEach(({ deck, info }) => list.appendChild(buildDeckItem(deck, info)));
    pickerEl.appendChild(list);
  } else if (!finishedUndelivered.length) {
    renderEmpty('All caught up — nothing to review.', 'New decks appear here the moment your tools publish them.');
  }

  // Background: deliver any finished-but-undelivered decks (e.g. the server was
  // down at finish time). Sequential + capped; retries next open.
  if (finishedUndelivered.length) {
    setStatus(DELIVERY_RETRY_STATUS, 'warn');
    deliverFinishedDecks(finishedUndelivered);
  }

  requestAnimationFrame(() => { try { pickerEl.scrollTop = pickerScroll; } catch {} });
}

function renderEmpty(title, sub) {
  const div = document.createElement('div');
  div.className = 'rs-picker-empty';
  div.innerHTML = `
    <div class="rs-empty-glyph">∅</div>
    <div class="rs-empty-title">${esc(title)}</div>
    ${sub ? `<div class="rs-empty-sub">${esc(sub)}</div>` : ''}
  `;
  pickerEl.appendChild(div);
}

async function deliverFinishedDecks(decks) {
  let cleared = 0;
  let failed = false;
  if (!retryLoggedThisOpen) {
    retryLoggedThisOpen = true;
    console.info(`[Swipe] Retrying delivery for ${decks.length} saved deck${decks.length === 1 ? '' : 's'}.`);
  }
  for (const deck of decks.slice(0, 20)) {
    try {
      const ok = await finishDeck(deck, { silent: true });
      if (ok) cleared++;
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      failed = true;
      setStatus(DELIVERY_RETRY_STATUS, 'warn');
      break;   // server down — leave the rest for the next open
    }
  }
  if (cleared && mode === 'picker') {
    if (!failed) setStatus('');
    renderPicker();
  }
}

function buildDeckItem(deck, info) {
  const { total, remaining, done, counts4 } = info;
  const ks = kindStyle(deck.kind);
    const li = document.createElement('li');
  li.className = 'rs-deck-item';
  li.style.setProperty('--rs-deck-accent', ks.color);
  li.innerHTML = `
    <button class="rs-deck-btn" type="button" data-deck-id="${esc(deck.id)}">
      <div class="rs-deck-row1">
        <span class="rs-deck-kind-pill" style="color: ${ks.color}; border-color: ${ks.color}">${ks.glyph} ${esc(ks.label)}</span>
        ${deck.source ? `<span class="rs-deck-source">${esc(deck.source)}</span>` : ''}
      </div>
      <div class="rs-deck-name">${esc(deck.name)}</div>
      ${deck.note ? `<div class="rs-deck-note">${esc(deck.note)}</div>` : ''}
      <div class="rs-deck-meter" aria-hidden="true">
        <div class="rs-deck-meter-fill" style="width: ${total ? (done / total) * 100 : 0}%"></div>
      </div>
      <div class="rs-deck-foot">
        <span class="rs-deck-remaining">${remaining} to review</span>
        <span class="rs-deck-tally">
          ${counts4.keep ? `<span class="rs-tally-keep">${counts4.keep}✓</span>` : ''}
          ${counts4.revise ? `<span class="rs-tally-revise">${counts4.revise}▣</span>` : ''}
          ${counts4.discard ? `<span class="rs-tally-discard">${counts4.discard}✕</span>` : ''}
          <span class="rs-tally-total">${total}</span>
        </span>
      </div>
    </button>
  `;
  li.querySelector('.rs-deck-btn').addEventListener('click', () => {
    openDeck(deck.id);
  });
  return li;
}

// One FIXED color + icon per content kind — a deck's type reads at a glance.
const KIND_STYLE = Object.freeze({
  [KIND.IMAGE]:   { color: '#3fbf7f', glyph: '🖼️', label: 'images'  },
  [KIND.VIDEO]:   { color: '#5ba0d9', glyph: '🎬', label: 'video'   },
  [KIND.AUDIO]:   { color: '#e0a93c', glyph: '🎙️', label: 'audio'   },
  [KIND.SCRIPT]:  { color: '#a78bfa', glyph: '📜', label: 'script'  },
  [KIND.CHAPTER]: { color: '#d98a5b', glyph: '📖', label: 'chapter' },
  [KIND.LINE]:    { color: '#e87fa8', glyph: '💬', label: 'lines'   },
  [KIND.LOGLINE]: { color: '#7fd4c1', glyph: '🎯', label: 'pitches' },
  [KIND.TEXT]:    { color: '#94a3b8', glyph: '📝', label: 'text'    },
});

function kindStyle(kind) {
  return KIND_STYLE[kind] || KIND_STYLE[KIND.TEXT];
}

// ── Swipe mode ──────────────────────────────────────────────────────────────
async function openDeck(deckId) {
  if (pickerEl) pickerScroll = pickerEl.scrollTop;
  const epoch = bumpNav();
  const deck = await getDeck(deckId);
  if (isStale(epoch) || !deck) return;
  currentDeck = deck;
  mode = 'swipe';

  pickerEl.hidden = true;
  surfaceEl.hidden = false;
  if (bannerEl) bannerEl.hidden = true;

  history.pushState({ rsView: 'deck', deckId }, '');

  headerSubEl.innerHTML = reviewChromeHtml({ backLabel: 'Back to decks' });
  headerSubEl.querySelector('.rs-back').addEventListener('click', () => leaveDeck());
  wireCardSizeControls(headerSubEl);

  document.documentElement.style.setProperty('--rs-accent', kindStyle(deck.kind).color);

  // Always start the surface fresh for each deck — reusing one view across
  // decks leaves stale closures over the previous deck.
  if (view && view.destroy) { try { view.destroy(); } catch {} }

  const cards = await getCardsByDeck(deckId);
  if (isStale(epoch)) return;
  await recoverVerdictsFromJournal(deckId);
  if (isStale(epoch)) return;
  setTagline(BRAND.tagline);
  view = createSwipeView(surfaceEl, {
    onVerdict: handleVerdict,
    onUndo:    handleUndo,
    onEmpty:   () => onDeckEmptied(currentDeck),
  });
  const decided = await getDecidedCardIds();
  if (isStale(epoch)) return;
  const pending = cards.filter((c) => !decided.has(c.id));
  view.setDeck(pending);
  setStatus(pending.length ? `${pending.length} of ${cards.length}` : '');
  measureCardBase();
}

// The swipe surface ran out of cards. That does NOT automatically mean the
// deck is finished — finishDeck() re-verifies against the store and refuses
// to deliver while any card lacks a verdict (the missing ones re-queue).
async function onDeckEmptied(deck) {
  if (!deck) { setStatus(''); return; }
  try {
    const ok = await finishDeck(deck, { silent: false });
    if (ok) setTimeout(() => backToPicker(), 900);
  } catch (err) {
    console.error('finish failed:', err);
    setStatus(DELIVERY_RETRY_STATUS, 'warn');
    setTimeout(() => backToPicker(), 1600);
  }
}

// Finish a deck: verify EVERY card has a verdict (poka-yoke — a deck can never
// finalize with a silently-missing decision), build the results payload,
// deliver it to the results folder, purge the deck. Returns true on delivery.
async function finishDeck(deck, { silent = false } = {}) {
  if (finishing.has(deck.id)) return false;
  finishing.add(deck.id);
  try {
    await pendingPersistence;
    const [cards, verdicts] = await Promise.all([
      getCardsByDeck(deck.id),
      getVerdictsForDeck(deck.id),
    ]);

    // Guard 1 (inherited): a deck with ZERO decisions is never "finished" —
    // that only happens when something upstream misfires. Leave it intact.
    if (!verdicts.length) {
      if (!silent) { setStatus(''); backToPicker(); }
      return false;
    }

    // Guard 2 (poka-yoke): every card must carry a verdict. If any are
    // missing, re-queue exactly those cards instead of finishing.
    const decidedIds = new Set(verdicts.map((v) => v.cardId));
    const missing = cards.filter((c) => !decidedIds.has(c.id));
    if (missing.length) {
      if (!silent && view) {
        view.setDeck(missing);
        setStatus(`${missing.length} card${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} a decision.`, 'warn');
      }
      return false;
    }

    if (!silent) setStatus('Delivering results…');
    const out = buildResultsPayload(deck, cards, verdicts);
    const res = await fetch('/api/swipe-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    });
    if (!res.ok) throw new Error(`deliver failed (HTTP ${res.status})`);
    await purgeDeckAfterSend(deck.id);
    if (!silent) setStatus(`Done — ${out.results.length} decision${out.results.length === 1 ? '' : 's'} delivered.`);
    return true;
  } finally {
    finishing.delete(deck.id);
  }
}

function backToPicker() {
  leaveDeck();
}

function leaveDeck() {
  exitSurface({ syncHistory: true });
}

function exitSurface({ syncHistory = true } = {}) {
  bumpNav();
  if (view && view.destroy) {
    try { view.destroy(); } catch { /* ignore */ }
    view = null;
  }
  currentDeck = null;
  renderPicker();
  if (syncHistory) {
    try { history.replaceState({ rsView: 'picker' }, ''); } catch { /* ignore */ }
  }
}

// Build the results payload — the public riah-swipe.results/2 shape. Consumers
// read `results[]`, match by cardId/meta, act on approved/revised, read notes.
function buildResultsPayload(deck, cards, verdicts) {
  // latest verdict per card wins
  const latest = new Map();
  for (const v of verdicts) {
    const prev = latest.get(v.cardId);
    if (!prev || v.decidedAt > prev.decidedAt) latest.set(v.cardId, v);
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  const results = [];
  for (const [cardId, v] of latest) {
    const card = byId.get(cardId) || {};
    results.push({
      cardId,
      title:     card.title || '',
      approved:  v.decision === 'keep',
      revised:   v.decision === 'revise',
      decision:  v.decision,
      note:      v.note || '',
      voiceNote: v.voiceNote || '',
      thumb:     v.thumb || '',
      content:   cardTextSnapshot(card),
      meta:      card.meta || null,
      media:     typeof card.media === 'string' ? card.media : (card.media && card.media.src) || '',
      decidedAt: v.decidedAt,
    });
  }
  return {
    schema:       'riah-swipe.results/2',
    batchId:      deck.id,
    deckName:     deck.name,
    project:      deck.source || '',
    returnTo:     deck.returnTo || deck.source || '',
    kind:         deck.kind || '',
    sentAt:       new Date().toISOString(),
    decidedCount: results.length,
    cardCount:    cards.length,
    results,
  };
}

// Small text snapshot for text-ish cards so the results file keeps the actual
// words that were judged. Capped so a giant doc can't bloat the file.
function cardTextSnapshot(card) {
  const kind = card.kind || '';
  let t = '';
  if (kind === 'script' || kind === 'chapter') {
    t = typeof card.media === 'string' ? card.media : (card.media && card.media.text) || '';
  } else if (kind === 'line' || kind === 'text' || kind === 'logline') {
    t = [card.title, card.preview].filter(Boolean).join('\n');
  }
  return String(t || '').slice(0, 20000);
}

function handleVerdict(payload) {
  const task = pendingPersistence.then(() => persistVerdict(payload));
  pendingPersistence = task.catch((err) => {
    console.error('Failed to persist verdict:', err);
    setStatus('Could not save that decision - check storage and try again.', 'error');
  });
  return task;
}

async function persistVerdict({ card, decision, note = '', voiceNote = '' }) {
  // Save-layer scrub: normalize the note at the persistence chokepoint so a
  // buggy client can never persist garbled voice-to-text.
  note = normalizeTranscript(note);
  const thumb = await captureApprovedThumb(card);
  const verdict = makeVerdict({
    cardId:  card.id,
    deckId:  card.deckId || (currentDeck && currentDeck.id) || '',
    decision,
    note,
    voiceNote,
    thumb,
  });
  try {
    await putVerdict(verdict);
    postVerdictJournal(verdict.deckId, {
      cardId: verdict.cardId,
      decision: verdict.decision,
      note: verdict.note,
      voiceNote: verdict.voiceNote,
      thumb: verdict.thumb,
      decidedAt: verdict.decidedAt,
    });
  } catch (err) {
    console.error('Failed to persist verdict:', err);
    setStatus('Could not save that decision — check storage and try again.', 'error');
  }
  if (navigator.vibrate) {
    try { navigator.vibrate(decision === 'keep' ? 8 : 14); } catch {}
  }
}

// Undo: erase the card's verdict(s) so it counts as undecided again.
function handleUndo(payload) {
  const task = pendingPersistence.then(() => persistUndo(payload));
  pendingPersistence = task;
  return task;
}

async function persistUndo({ card }) {
  try {
    await deleteVerdictsForCard(card.id);
    postVerdictJournal(card.deckId || (currentDeck && currentDeck.id) || '', { cardId: card.id, undo: true });
    setStatus('Undone — that one’s back on top.');
  } catch (err) {
    console.error('Failed to undo verdict:', err);
    setStatus('Could not undo — see console.', 'error');
  }
}

// ── Status line ─────────────────────────────────────────────────────────────
function postVerdictJournal(batchId, verdict) {
  if (!batchId) return;
  fetch('/api/verdict-journal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId, verdict }),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }).catch(() => console.warn('[Swipe] verdict journal unavailable; local save is intact.'));
}

async function recoverVerdictsFromJournal(deckId) {
  const local = await getVerdictsForDeck(deckId);
  if (local.length) return 0;
  try {
    const res = await fetch(`/api/verdict-journal/${encodeURIComponent(deckId)}`, { cache: 'no-store' });
    if (!res.ok) return 0;
    const payload = await res.json();
    const recovered = replayVerdictJournal(payload.entries, deckId);
    await Promise.all(recovered.map((verdict) => putVerdict(verdict)));
    return recovered.length;
  } catch {
    return 0;
  }
}

function showMissingMedia(event) {
  const media = event.target;
  if (!media || media.tagName !== 'IMG') return;
  const frame = media.closest('.rs-card-media');
  if (!frame || frame.querySelector('.rs-media-missing')) return;
  frame.classList.add('rs-card-media-missing');
  const badge = document.createElement('div');
  badge.className = 'rs-media-missing';
  const deckId = (currentDeck && currentDeck.id) || '<deckId>';
  badge.textContent = `media missing — keep media inside decks/${deckId}/`;
  frame.appendChild(badge);
}

function setStatus(msg, tone = 'info') {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.dataset.tone = tone;
}

function setTagline(text) {
  const t = document.querySelector('.rs-tagline');
  if (t) t.textContent = text;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Network awareness ───────────────────────────────────────────────────────
function monitorNetwork() {
  const sync = () => {
    document.documentElement.classList.toggle('rs-offline', !navigator.onLine);
  };
  window.addEventListener('online',  sync);
  window.addEventListener('offline', sync);
  sync();
}
