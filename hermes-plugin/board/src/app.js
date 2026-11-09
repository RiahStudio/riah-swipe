// src/app.js
// Controller — wires the data layer (decks/cards/verdicts) to the view
// (deck picker + swipe surface). Three modes:
//
//   1. PICKER  → list of decks with remaining counts. Tap a deck → swipe mode.
//   2. SWIPE   → one deck's cards loaded into the swipe surface. Tap the back
//                arrow → return to picker.
//   3. REVIEW  → re-open an already-swiped deck from "Recently Swiped" to
//                change decisions and notes. Shows the prior pick on each card;
//                Yes / Revise / No writes again. (Was read-only demo until
//                the user asked to re-change things, 2026-07-17.)
//
// This is the only place the data layer and the DOM meet. The swipe-view
// doesn't know what a deck is — it just renders the cards it's handed.

import { KIND, makeVerdict } from './data/model.js';
import {
  getAllDecks,
  getDeck,
  getCardsByDeck,
  getDecidedCardIds,
  putVerdict,
  getAllVerdicts,
  getVerdictsForDeck,
  deleteVerdictsForCard,
  getSentDeckIds,
  expireOldHistory,
  getAllHistory,
  putHistoryBatch,
  snapshotDeckToHistory,
} from './data/store.js';
import { createSwipeView, normalizeTranscript } from './swipe-view.js?v=20260720hoverlift';
import { createHistoryView } from './history-view.js';
import { captureApprovedThumb } from './logic/approved-thumb.js';
import { loadBundledDecks, fetchCatalogOrder } from './data/deck-loader.js?v=20260901lock';
import {
  DECK_SORT_DEFAULT,
  normalizeDeckSort,
  sortDeckItems,
} from './logic/deck-sort.js?v=20260901lock';
// Card size (the swipe subject only — not browser zoom). Continuous slider.
const CARD_SIZE_KEY = 'rsw-card-size';
// Range set by the user 2026-07-20; max raised 2026-08-13 once zoom actually
// pastes the frame (not just a taller empty box). DEFAULT stays at 1 (fit).
const CARD_SIZE_MIN = 0.4;   // was 0.7 — shrink a genuinely huge card right down
const CARD_SIZE_MAX = 3.0;   // was 2.5 — real zoom past the frame; room to go super big
const CARD_SIZE_DEFAULT = 1;
// Bumping this re-applies CARD_SIZE_DEFAULT once, so a size saved under an
// earlier build doesn't override the current default forever. (Bumped again to
// clear the brief 2.5 default — that was a misread of the request.)
const CARD_SIZE_DEFAULT_V = '2026-08-25a';
const CARD_SIZE_V_KEY = 'rsw-card-size-default-v';

function clampCardSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, v));
}

function readCardSize() {
  try {
    // One-time adoption of a new default (see CARD_SIZE_DEFAULT_V).
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

// Deck-list order. Newest first is the default so a just-published batch
// lands at the top instead of sinking under ID-ordered IndexedDB dumps.
const DECK_SORT_KEY = 'rsw-deck-sort';

function readDeckSort() {
  try {
    return normalizeDeckSort(localStorage.getItem(DECK_SORT_KEY));
  } catch { /* ignore */ }
  return DECK_SORT_DEFAULT;
}

function applyDeckSort(value) {
  const next = normalizeDeckSort(value);
  try { localStorage.setItem(DECK_SORT_KEY, next); } catch { /* ignore */ }
  return next;
}

function wireDeckSortControls(root) {
  const select = root && root.querySelector('[data-deck-sort]');
  if (!select) return;
  select.value = readDeckSort();
  select.addEventListener('change', () => {
    applyDeckSort(select.value);
    pickerScroll = 0;
    if (mode === 'picker' && !historyActive) renderPicker();
  });
}

function reviewChromeHtml({ backLabel = 'Back to decks' } = {}) {
  // Size slider is on this row. On pictures it grows the whole review column.
  return `
    <button class="rs-back" type="button" aria-label="${esc(backLabel)}">←</button>
    <label class="rs-card-size" title="Size of the thing you're judging">
      <input type="range" class="rs-card-size-slider" data-card-size
             min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="0.05"
             aria-label="Card size" />
    </label>
  `;
}

// ── Settings menu ───────────────────────────────────────────────────────────
// Holds the card-size slider, deck order, and account links.
//
// The size PERSISTS across close — deliberately. An earlier build snapped an
// oversized card back to fit on close, which was useless in practice: this panel
// sits over the card, so you can't judge the size until the menu is shut, and
// snapping back meant the setting never survived long enough to look at
//.
//
// What makes a big card safe is not resetting it, it's `.rs-header { z-index: 50 }`
// — the gear stays clickable at ANY card size, so you can always reopen this and
// size it back down. That's the real fix; snap-back was treating the symptom.
function wireSettingsMenu() {
  const btn = document.getElementById('rs-settings-btn');
  const panel = document.getElementById('rs-settings-panel');
  if (!btn || !panel) return;

  const isOpen = () => !panel.hasAttribute('hidden');

  function open() {
    panel.removeAttribute('hidden');
    btn.setAttribute('aria-expanded', 'true');
    const slider = panel.querySelector('[data-card-size]');
    if (slider) slider.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    panel.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', 'false');
    // Card size is left exactly as set — see the note above.
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen() ? close() : open();
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const pickerEl    = document.getElementById('rs-picker');
const historyEl   = document.getElementById('rs-history');
const surfaceEl   = document.getElementById('rs-surface');
const headerSubEl = document.getElementById('rs-header-sub');
const statusEl    = document.getElementById('rs-status');
const tabsEl      = document.getElementById('rs-tabs');

// ── App state ───────────────────────────────────────────────────────────────
let view = null;
let currentDeck = null;
let mode = 'picker';
let historyView = null;
let historyActive = false;
let pickerScroll = 0;   // remembered deck-list scroll, restored when you press Back
// Bumped on every leave / new open. In-flight openDeck/showDeckDone checks this
// after awaits so a Back click can't get overwritten when IndexedDB returns later
// (the Brave "goes back, then snaps into the deck again" bug).
let navEpoch = 0;

function bumpNav() { return ++navEpoch; }
function isStale(epoch) { return epoch !== navEpoch; }

// ── Bootstrap ───────────────────────────────────────────────────────────────
init().then(() => { window.__rsBooted = true; }).catch((err) => {
  console.error('Riah Swipe bootstrap failed:', err);
  window.__rsBooted = true;
  setStatus('Failed to load. Refresh to try again.', 'error');
  if (typeof window.__rsModuleFailed === 'function') window.__rsModuleFailed();
});

async function init() {
  // Keep our data durable: ask the browser not to evict IndexedDB (verdicts,
  // "finished" tombstones, swipe history). Eviction is one way finished decks
  // could quietly come back and in-progress decks could reset to the start.
  // Best-effort; ignored where unsupported.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  // Card size persists as set, at any size — a big card is no longer a trap now
  // that the header outranks it and the gear stays clickable.
  applyCardSize(readCardSize());
  wireCardSizeControls(document);
  wireDeckSortControls(document);
  wireSettingsMenu();
  window.addEventListener('resize', measureCardBase);
  if (surfaceEl) {
    const onMediaReady = (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.rs-card-media')) measureCardBase();
    };
    surfaceEl.addEventListener('load', onMediaReady, true);
    surfaceEl.addEventListener('loadeddata', onMediaReady, true);
  }
  // Paint the picker IMMEDIATELY from what's already on this device — opening
  // Riah Swipe should feel instant, never gated on the network. Newly-published
  // batches are pulled in the BACKGROUND (below); the picker refreshes in place
  // only if something actually arrived.
  expireOldHistory().catch(() => {});   // quietly drop Recently Swiped older than a week
  await renderPicker();
  monitorNetwork();

  // Tab switching: Decks ↔ Recently Swiped
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === 'history' && !historyActive) showHistory();
    else if (tab === 'decks' && historyActive) hideHistory();
  });

  // Quiet boot flush — any swipes already on this device go home without a
  // Sync button. Mid-session, every verdict schedules its own flush (below).
  flushAllHomeQuiet().catch((err) => console.warn('boot flush skipped:', err));

  // ── History API: Android back / browser back ─────────────────────────────
  // openDeck pushStates a deck entry. Browser back pops it → we only restore UI
  // (stack is already correct). The in-app ← button uses replaceState instead of
  // history.back() — back()+popstate was bouncing the deck back on in Brave.
  history.replaceState({ rsView: 'picker' }, '');
  window.addEventListener('popstate', () => {
    if (mode === 'swipe' || mode === 'demo') {
      exitSurface({ syncHistory: false });
    }
  });

  // Background: import any newly-published batches, then refresh the picker in
  // place if new decks came in — but only while the user is still on the picker,
  // so a late import never yanks them out of a deck they've already opened.
  loadBundledDecks()
    .then(async (stats) => {
      // Re-render after the background sync so BOTH newly-imported decks AND
      // retired/purged old decks reflect right away. (The retired-purge clears
      // already-swiped decks without bumping any "loaded" count, so we gate only
      // on the user still being on the picker — not on new decks having arrived.)
      // Exception: if he is sitting inside a deck we just pulled back, leave it
      // so a refresh isn't stuck on a blank title card.
      const retired = (stats && stats.retired) || [];
      if (currentDeck && (retired.includes(currentDeck.id) || !(await getDeck(currentDeck.id)))) {
        exitSurface({ syncHistory: true });
        return;
      }
      if (mode === 'picker' && !historyActive) renderPicker();
    })
    .catch((err) => console.warn('Deck auto-load skipped:', err));
}

async function showHistory() {
  historyActive = true;
  mode = 'picker';   // Recently Swiped is part of the picker-level page
  if (view && view.destroy) {
    try { view.destroy(); } catch { /* ignore */ }
    view = null;
  }
  pickerEl.hidden = true;
  historyEl.hidden = false;
  surfaceEl.hidden = true;
  headerSubEl.innerHTML = '';   // clear any demo back-arrow header
  tabsEl.hidden = false;
  document.documentElement.style.removeProperty('--rs-accent');
  setTagline('Recently Swiped');
  updateTabs('history');

  // onOpenDeck → review the tapped deck (change decisions / notes).
  if (!historyView) historyView = createHistoryView(historyEl, { onOpenDeck: openHistoryDeck });
  await historyView.refresh();
}

function hideHistory() {
  historyActive = false;
  historyEl.hidden = true;
  pickerEl.hidden = false;
  setTagline('Keep · Cut');
  updateTabs('decks');
}

function updateTabs(active) {
  for (const btn of tabsEl.querySelectorAll('.rs-tab')) {
    btn.classList.toggle('rs-tab-active', btn.dataset.tab === active);
  }
}

// ── Picker mode ─────────────────────────────────────────────────────────────
async function renderPicker() {
  mode = 'picker';
  historyActive = false;
  if (view && view.destroy) {
    try { view.destroy(); } catch { /* ignore */ }
    view = null;
  }
  pickerEl.hidden = false;
  historyEl.hidden = true;
  surfaceEl.hidden = true;
  headerSubEl.innerHTML = '';
  tabsEl.hidden = false;
  updateTabs('decks');
  document.documentElement.style.removeProperty('--rs-accent');
  setTagline('Keep · Cut');

  const [decks, decided, allVerdicts, sentIds] = await Promise.all([
    getAllDecks(),
    getDecidedCardIds(),
    getAllVerdicts(),
    getSentDeckIds(),
  ]);

  pickerEl.innerHTML = '';
  if (decks.length === 0) { renderEmpty('No decks yet.'); return; }

  // Count verdicts per deck for the at-a-glance tally.
  const counts = new Map();
  for (const v of allVerdicts) {
    const c = counts.get(v.deckId) || { keep: 0, revise: 0, discard: 0 };
    c[v.decision] = (c[v.decision] || 0) + 1;
    counts.set(v.deckId, c);
  }

  // Fetch card counts in parallel so the picker doesn't render in serial.
  const deckCards = await Promise.all(decks.map((d) => getCardsByDeck(d.id)));

  // Decks tab = still to swipe. Finished work lives on Recently Swiped until
  // the host files it; the week clock starts only after that pickup
  //. Decisions still send home right away.
  const review = [];
  const completed = [];
  decks.forEach((deck, i) => {
    if (sentIds.has(deck.id)) return;                 // already archived → gone
    const cards = deckCards[i];
    const total = cards.length;
    if (total === 0) return;                          // empty deck → nothing to show
    const remaining = cards.filter((c) => !decided.has(c.id)).length;
    const item = {
      deck,
      info: {
        total,
        remaining,
        done:    total - remaining,
        counts4: counts.get(deck.id) || { keep: 0, revise: 0, discard: 0 },
      },
      firstCard: cards[0],
    };
    if (remaining === 0) completed.push(item);
    else review.push(item);
  });

  if (review.length) {
    const list = document.createElement('ul');
    list.className = 'rs-deck-list';
    const catalogOrder = await fetchCatalogOrder();
    sortDeckItems(review, readDeckSort(), catalogOrder).forEach(({ deck, info, firstCard }) => {
      list.appendChild(buildDeckItem(deck, info, false, firstCard));
    });
    pickerEl.appendChild(list);
    observePickerThumbs(list);
  } else {
    renderEmpty('All caught up — nothing to review.');
  }

  if (completed.length) {
    completed.forEach(({ deck }) => {
      snapshotDeckToHistory(deck.id).catch(() => {});
    });
    archiveFinishedDecks(completed.map((c) => c.deck));
  }

  // Restore the list scroll position so tapping a deck and pressing Back lands
  // you back where you were in the list, not at the top.
  requestAnimationFrame(() => { try { pickerEl.scrollTop = pickerScroll; } catch {} });
}

// Small centered message for an empty / all-caught-up picker.
function renderEmpty(msg) {
  const div = document.createElement('div');
  div.className = 'rs-picker-empty';
  div.textContent = msg;
  pickerEl.appendChild(div);
}

// Send each finished deck's decisions home. Do NOT purge — nothing unfiled
// may be deleted. Sequential + capped so a backlog
// can't hammer the server; whatever doesn't clear this pass retries next open.
async function archiveFinishedDecks(decks) {
  for (const deck of decks.slice(0, 20)) {
    try {
      await exportDeckResults(deck);
      await new Promise((r) => setTimeout(r, 250));   // gentle on the rate limit
    } catch {
      break;   // offline or throttled — leave the rest for the next open
    }
  }
}

// Build one deck row for the picker. `isDone` decks live in the Completed
// section and carry the done styling; tapping either opens the deck (a done
// deck opens straight to the "Send results" panel). `firstCard` (the deck's
// first card) drives the leading cover thumbnail (App mock, screenshot 28).
function buildDeckItem(deck, info, isDone, firstCard) {
  const { total, remaining, done, counts4 } = info;
  const ks = kindStyle(deck.kind);
  const li = document.createElement('li');
  li.className = 'rs-deck-item' + (isDone ? ' rs-deck-item-done' : '');
  li.style.setProperty('--rs-deck-accent', ks.color);
  li.innerHTML = `
    <button class="rs-deck-btn" type="button" data-deck-id="${esc(deck.id)}" ${isDone ? 'aria-label="Deck complete — send picks"' : ''}>
      ${buildDeckThumb(firstCard, deck)}
      <div class="rs-deck-body">
        <div class="rs-deck-row1">
          <span class="rs-deck-kind-pill" style="color: ${ks.color}; border-color: ${ks.color}">${ks.glyph} ${esc(ks.label)}</span>
          ${deck.source ? `<span class="rs-deck-source">${esc(deck.source)}</span>` : ''}
        </div>
        <div class="rs-deck-name">${esc(deck.name)}</div>
        ${deck.note ? `<div class="rs-deck-note">${esc(deck.note)}</div>` : ''}
        <div class="rs-deck-meter" aria-hidden="true">
          <div class="rs-deck-meter-fill" style="width: ${total ? (done / total) * 100 : 0}%"></div>
        </div>
      </div>
      <div class="rs-deck-foot">
        <span class="rs-deck-remaining">${remaining ? `${remaining} to review` : 'Done — kept'}</span>
        <span class="rs-deck-tally">
          ${counts4.keep ? `<span class="rs-tally-keep">${counts4.keep}✓</span>` : ''}
          ${counts4.revise ? `<span class="rs-tally-revise">${counts4.revise}▣</span>` : ''}
          ${counts4.discard ? `<span class="rs-tally-discard">${counts4.discard}✕</span>` : ''}
          <span class="rs-tally-total">${total}</span>
        </span>
      </div>
    </button>
  `;
  li.querySelector('.rs-deck-btn').addEventListener('click', () => openDeck(deck.id));
  return li;
}

// Leading 46px cover thumbnail for a deck row (App mock, screenshot 28):
//   image  → the first card's media itself
//   video  → its poster if present, else just the play-badge tile (no image)
//   audio  → a mini "wave" tile with ♪
//   text-ish (script/chapter/line/text/logline) → a stamped file card: the deck's
//     project NAME + the kind rubber-stamp (so two script decks never look alike)
// Always a background-image DIV (for image/video), never an <img src> — so a
// missing/broken path degrades to an empty bordered tile, never a broken-image icon.
// Covers load only when the row is near the screen — a full picker of 4MB
// pictures used to fetch every cover at once and freeze the open.
let pickerThumbObserver = null;

function observePickerThumbs(root) {
  if (typeof IntersectionObserver !== 'function') {
    root.querySelectorAll('[data-thumb-src]').forEach(applyPickerThumb);
    return;
  }
  if (!pickerThumbObserver) {
    pickerThumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        applyPickerThumb(entry.target);
        pickerThumbObserver.unobserve(entry.target);
      }
    }, { root: pickerEl, rootMargin: '120px' });
  }
  root.querySelectorAll('[data-thumb-src]').forEach((el) => pickerThumbObserver.observe(el));
}

function applyPickerThumb(el) {
  const src = el.getAttribute('data-thumb-src');
  if (!src) return;
  el.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`;
  el.removeAttribute('data-thumb-src');
}

function buildDeckThumb(firstCard, deck) {
  const kind  = (firstCard && firstCard.kind) || (deck && deck.kind) || KIND.TEXT;
  const media = firstCard && firstCard.media;
  const accent = kindStyle(kind).color;

  if (kind === KIND.IMAGE) {
    const src = typeof media === 'string' ? media : '';
    if (!src) return `<div class="rs-deck-thumb" aria-hidden="true"></div>`;
    return `<div class="rs-deck-thumb" data-thumb-src="${esc(src)}" aria-hidden="true"></div>`;
  }
  if (kind === KIND.VIDEO) {
    const poster = (media && typeof media === 'object') ? media.poster : '';
    const play = `<span class="rs-deck-thumb-play"></span>`;
    if (!poster) return `<div class="rs-deck-thumb" aria-hidden="true">${play}</div>`;
    return `<div class="rs-deck-thumb" data-thumb-src="${esc(poster)}" aria-hidden="true">${play}</div>`;
  }
  if (kind === KIND.AUDIO) {
    return `<div class="rs-deck-thumb rs-deck-thumb-audio" style="--thumb-accent: ${esc(accent)}" aria-hidden="true">
      <span class="rs-deck-thumb-waves" aria-hidden="true"></span>
      <span class="rs-deck-thumb-audio-mark">♪</span>
    </div>`;
  }
  // Text-ish decks: a stamped file card. The deck's project NAME is the hero (two
  // script decks must not look identical) and the kind rides along as a little
  // rubber-stamp. Accent + stamp follow the DECK's kind so the tile agrees with the
  // kind pill sitting right beside it in the row.
  const stamp = kindStyle((deck && deck.kind) || kind);
  const name  = deckDisplayName(deck, firstCard);
  return `<div class="rs-deck-thumb rs-deck-thumb-text" style="--thumb-accent: ${esc(stamp.color)}" aria-hidden="true">
    <span class="rs-deck-thumb-name" style="font-size: ${deckThumbNamePx(name)}px">${esc(name)}</span>
    <span class="rs-deck-thumb-stamp">${esc(stamp.label)}</span>
  </div>`;
}

// Bucket words that turn up as the HEAD of a deck name ("Loglines — The Kermort &
// Porgy Show"). When the head is one of these, the real title is the tail instead.
const THUMB_BUCKET_HEAD = /^(?:loglines?|scripts?|chapters?|drafts?|notes?|beats?|lines?|ideas?|covers?|concepts?|pitches?|outlines?|treatments?|pages?|shots?|panels?|episodes?|batch(?:es)?|round\s*\d+|r\d+)$/i;

// The project name for the cover card:
//   "Tom Sawyer Cultivator — Chapter 2: The Glorious Ward-Painter (r2 …)"
//     → "Tom Sawyer Cultivator"    (head IS the project)
//   "Loglines — The Kermort & Porgy Show"
//     → "The Kermort & Porgy Show" (head is only a bucket word, so take the tail)
function deckDisplayName(deck, firstCard) {
  let n = String((deck && deck.name) || (firstCard && firstCard.title) || '')
    .replace(/\s+/g, ' ').trim();
  if (!n) return '';
  n = n.replace(/\s*\([^)]*\)\s*$/, '').trim();      // drop a trailing "(r2 — …)" aside
  const parts = n.split(/\s*[—–|]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) n = THUMB_BUCKET_HEAD.test(parts[0]) ? parts.slice(1).join(' ') : parts[0];
  n = n.split(/\s*:\s*/)[0].trim();                  // "Chapter 2: The Glorious …" → "Chapter 2"
  return n.slice(0, 32);
}

// Shrink the name to fit the 46px card — short names get to be bold and big.
function deckThumbNamePx(name) {
  const n = String(name || '').length;
  if (n <= 12) return 10;
  if (n <= 20) return 8.5;
  if (n <= 28) return 8;
  return 7.5;
}

// One FIXED color + icon per content kind: the deck's
// type must read at a glance, every time, everywhere. A deck's own `accent`
// is no longer used for theming — kind decides.
//
// NAMING: a kind is labelled for what it actually IS —
// logline, script, book. `text` is reserved for something genuinely, literally
// text and should almost never appear on screen. Do NOT collapse `logline` back
// into `text`; that was the old behaviour and it read wrong on the deck pill.
const KIND_STYLE = Object.freeze({
  [KIND.IMAGE]:   { color: '#3fbf7f', glyph: '🖼️', label: 'images'  }, // green
  [KIND.VIDEO]:   { color: '#5ba0d9', glyph: '🎬', label: 'video'   }, // blue
  [KIND.AUDIO]:   { color: '#e0a93c', glyph: '🎙️', label: 'audio'   }, // amber
  [KIND.SCRIPT]:  { color: '#a78bfa', glyph: '📜', label: 'script'  }, // purple
  [KIND.CHAPTER]: { color: '#d98a5b', glyph: '📖', label: 'book'    }, // copper
  [KIND.LINE]:    { color: '#e87fa8', glyph: '💬', label: 'lines'   }, // pink
  [KIND.TEXT]:    { color: '#94a3b8', glyph: '📝', label: 'text'    }, // slate — literal text ONLY
  [KIND.LOGLINE]: { color: '#94a3b8', glyph: '📝', label: 'logline' }, // slate, but its own word
});

function kindStyle(kind) {
  return KIND_STYLE[kind] || KIND_STYLE[KIND.TEXT];
}

// ── Swipe mode ──────────────────────────────────────────────────────────────
async function openDeck(deckId) {
  // Remember where the deck list was scrolled so Back returns you there, not to
  // the top of the list.
  if (pickerEl) pickerScroll = pickerEl.scrollTop;
  const epoch = bumpNav();

  // Load everything BEFORE showing the swipe surface. Showing UI early, then
  // awaiting IndexedDB, let Back restore the picker — and a late continuation
  // would remount the deck on top (Brave snap-back).
  const deck = await getDeck(deckId);
  if (isStale(epoch) || !deck) return;
  const cards = await getCardsByDeck(deckId);
  if (isStale(epoch)) return;
  const decided = await getDecidedCardIds();
  if (isStale(epoch)) return;
  const pending = cards.filter((c) => !decided.has(c.id));

  currentDeck = deck;
  mode = 'swipe';

  pickerEl.hidden = true;
  historyEl.hidden = true;
  surfaceEl.hidden = false;
  tabsEl.hidden = true;

  // Push a history entry so Android back / browser back returns to the picker
  // instead of navigating away from Swipe. The popstate handler in init() picks
  // this up and restores the picker UI.
  history.pushState({ rsView: 'deck', deckId }, '');

  // Header: back + size slider only. The card is the feature.
  headerSubEl.innerHTML = reviewChromeHtml({ backLabel: 'Back to decks' });
  headerSubEl.querySelector('.rs-back').addEventListener('click', () => leaveDeck());
  wireCardSizeControls(headerSubEl);

  // Accent comes from the KIND, not the deck — same kind, same color.
  document.documentElement.style.setProperty('--rs-accent', kindStyle(deck.kind).color);

  // Always start the surface fresh for each deck. Reusing one view across decks
  // left a stale "all decided" panel closed over the FIRST deck, which is what
  // made the app unusable after finishing one deck and opening another.
  if (view && view.destroy) { try { view.destroy(); } catch {} }
  if (isStale(epoch)) return;

  setTagline('Keep · Cut');
  view = createSwipeView(surfaceEl, {
    onVerdict: handleVerdict,
    onUndo:    handleUndo,
    onEmpty:   () => showDeckDone(currentDeck),
  });
  view.setDeck(pending);
  setDeckCount(pending.length ? `${pending.length} of ${cards.length}` : '');
  setStatus('');
  measureCardBase();
  // Empty/finished deck: setDeck()'s render already fires onEmpty → showDeckDone()
  // exactly once. A second explicit showDeckDone(deck) call here used to double-fire
  // backToPicker()/history.back() on an empty open.
}

// When every card in a deck is decided, send the results to the hosting server.
// The app POSTs the results payload to /api/swipe-results (same origin); the
// bundled server (server/serve.mjs) stores it under <root>/data/. Only if no
// server can take the POST (a bare file:// open) does it fall back to
// downloading the results file.
const HOSTED = false;

async function showDeckDone(deck) {
  if (!deck) { setStatus(''); return; }
  const epoch = navEpoch;
  // Finish-guard: a deck may only enter finished/archive when EVERY card has a
  // recorded verdict. onEmpty can fire with a drained view stack while the store
  // still has undecided cards (async verdict race, undo mismatch, etc.). Block
  // archive, jump to the first unswiped card, surface the true remaining count.
  // Safety net (v1.6.4): also never archive/purge a deck with zero decisions —
  // "done with nothing decided" only happens on upstream misfire (2026-06-10).
  try {
    const [cards, decided] = await Promise.all([
      getCardsByDeck(deck.id),
      getDecidedCardIds(),
    ]);
    if (isStale(epoch) || mode !== 'swipe') return;
    let unswiped = cards.filter((c) => !decided.has(c.id));
    if (unswiped.length > 0) {
      // Last verdict may still be writing (IndexedDB). One short retry before
      // bouncing the user back onto cards they already decided ("stuck" loop).
      await new Promise((r) => setTimeout(r, 250));
      if (isStale(epoch) || mode !== 'swipe') return;
      const decided2 = await getDecidedCardIds();
      if (isStale(epoch) || mode !== 'swipe') return;
      unswiped = cards.filter((c) => !decided2.has(c.id));
    }
    if (unswiped.length > 0) {
      if (isStale(epoch) || mode !== 'swipe' || !view || typeof view.setDeck !== 'function') return;
      view.setDeck(unswiped);
      setDeckCount(`${unswiped.length} of ${cards.length}`);
      setStatus('');
      return;
    }
    if (!cards.length) { setStatus(''); leaveDeck(); return; }
    const vs = await getVerdictsForDeck(deck.id);
    if (isStale(epoch) || mode !== 'swipe') return;
    if (!vs || !vs.length) { setStatus(''); leaveDeck(); return; }
  } catch { if (!isStale(epoch) && mode === 'swipe') { setStatus(''); leaveDeck(); } return; }
  if (isStale(epoch) || mode !== 'swipe') return;
  // Finished a deck → send decisions home. Lives on Recently Swiped until
  // the host files it; the week clock starts only after that pickup.
  setStatus('Saving…');
  try {
    snapshotDeckToHistory(deck.id).catch(() => {});
    const { count, transport } = await exportDeckResults(deck);
    if (isStale(epoch)) return;
    if (transport === 'download') {
      setStatus(`Saved — ${count} decision${count === 1 ? '' : 's'} saved to a file; files on next sync.`);
    } else {
      setStatus(`Saved — ${count} decision${count === 1 ? '' : 's'}.`);
    }
  } catch (err) {
    console.error('archive failed:', err);
    if (isStale(epoch)) return;
    setStatus(HOSTED
      ? 'Saved here — will archive when you reconnect.'
      : 'Saved here — start the Swipe server to send.');
  }
  if (isStale(epoch) || mode !== 'swipe') return;
  setTimeout(() => { if (!isStale(epoch)) backToPicker(); }, 900);
}

// Leave the open deck / review. Always restores UI immediately.
// Never call history.back() here — on Brave that bounced the deck back on
// (and raced with in-flight openDeck). In-app ← uses replaceState; browser back
// already popped the stack (syncHistory: false from popstate).
function backToPicker() {
  leaveDeck();
}

function leaveDeck() {
  exitSurface({ syncHistory: true });
}

function exitSurface({ syncHistory = true } = {}) {
  const wasDemo = mode === 'demo';
  bumpNav(); // cancel any in-flight openDeck / showDeckDone

  if (view && view.destroy) {
    try { view.destroy(); } catch { /* ignore */ }
    view = null;
  }
  currentDeck = null;

  if (wasDemo) showHistory();
  else renderPicker();

  if (syncHistory) {
    try {
      history.replaceState({ rsView: wasDemo ? 'history' : 'picker' }, '');
    } catch { /* ignore */ }
  }
}

// Build the results payload a department's return-bridge consumes. Shape is
// stable: department reads `results[]`, matches by cardId/meta, files approved
// assets, surfaces notes. `partial:true` flags a deck that isn't fully decided
// yet (sent by "Sync now") so the consumer can treat it as in-progress, not final.
function buildResultsPayload(deck, cards, verdicts, { partial = false } = {}) {
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
      revised:   v.decision === 'revise',   // "partially right, needs another pass" — routes back to the department for revision
      decision:  v.decision,
      note:      v.note || '',
      voiceNote: v.voiceNote || '',     // data-URI audio, '' if none
      thumb:     v.thumb || '',         // tiny data-URI (every decision) → approved-thumbs/ + swipe-history/
      content:   cardTextSnapshot(card),// text body for script/line/text kinds → swipe-history/
      meta:      card.meta || null,     // carries character/voice/outFile for routing
      media:     typeof card.media === 'string' ? card.media : (card.media && card.media.src) || '',
      decidedAt: v.decidedAt,
    });
  }
  return {
    schema:       'riah-swipe.results/1',
    batchId:      deck.id,
    deckName:     deck.name,
    project:      deck.source || '',    // the show/project this batch belongs to
    department:   deck.returnTo || deck.source || '',
    kind:         deck.kind || '',
    sentAt:       new Date().toISOString(),
    partial:      partial || undefined, // present only for an in-progress deck
    decidedCount: results.length,
    cardCount:    cards.length,
    results,
  };
}

// POST a results payload to whatever server hosts the app — same-origin.
//   • Local server (server/serve.mjs): writes the results under <root>/data/.
//   • Bare file:// (no server, or a stale server with no /api/swipe-results):
//     falls back to a download so the verdicts are never lost.
async function sendResults(out, { fallbackName, allowDownload = true } = {}) {
  try {
    const res = await fetch('/api/swipe-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    });
    if (res.ok) return { count: out.results.length, transport: 'server' };
    if (HOSTED) throw new Error(`send failed (HTTP ${res.status})`);
  } catch (err) {
    if (HOSTED) throw err;
    // No local server (bare file, or a stale server with no endpoint).
  }
  // Mid-swipe auto-flush must NOT spam Downloads — only finished-deck / explicit
  // paths pass allowDownload:true.
  if (allowDownload && fallbackName) {
    downloadJSON(fallbackName, out);
    return { count: out.results.length, transport: 'download' };
  }
  return { count: out.results.length, transport: 'failed' };
}

// Finish ONE fully-decided deck: build + send its results.
async function exportDeckResults(deck) {
  const [cards, verdicts] = await Promise.all([
    getCardsByDeck(deck.id),
    getVerdictsForDeck(deck.id),
  ]);
  const out = buildResultsPayload(deck, cards, verdicts, { partial: false });
  return sendResults(out, { fallbackName: `${deck.id}.results.json`, allowDownload: true });
}

// Auto-flush — every swipe (and boot) sends home. Replaces the old "Sync my
// swipes" button. Debounced per deck so a fast swipe streak is one POST.
const flushTimers = new Map();

function scheduleDeckFlush(deckId) {
  if (!deckId) return;
  const prev = flushTimers.get(deckId);
  if (prev) clearTimeout(prev);
  flushTimers.set(deckId, setTimeout(() => {
    flushTimers.delete(deckId);
    flushDeckHome(deckId).catch((err) => console.warn('[auto-flush]', err));
  }, 400));
}

async function flushDeckHome(deckId) {
  const [deck, verdicts, histRows] = await Promise.all([
    getDeck(deckId),
    getVerdictsForDeck(deckId),
    getAllHistory().then((all) => all.filter((h) => h.deckId === deckId)),
  ]);
  let out = null;
  if (deck) {
    const cards = await getCardsByDeck(deckId);
    if (!verdicts.length) return;
    const decided = new Set(verdicts.map((v) => v.cardId));
    const partial = cards.length > 0 && decided.size < cards.length;
    out = buildResultsPayload(deck, cards, verdicts, { partial });
  } else if (histRows.length) {
    const fakeDeck = {
      id: deckId,
      name: histRows[0].deckName || deckId,
      source: histRows[0].project || '',
      returnTo: histRows[0].project || '',
      kind: histRows[0].kind || '',
    };
    const fakeCards = histRows.map((r) => rowToDemoCard(r, deckId));
    const fakeVerdicts = histRows.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      deckId,
      decision: r.decision,
      note: r.note || '',
      voiceNote: r.voiceNote || '',
      thumb: r.thumb || '',
      decidedAt: r.decidedAt,
    }));
    const merged = verdicts.length ? verdicts : fakeVerdicts;
    out = buildResultsPayload(fakeDeck, fakeCards, merged, { partial: true });
  }
  if (!out || !out.results.length) return;
  // Never download on auto-flush — Downloads spam was the old Sync fallback.
  await sendResults(out, { allowDownload: false });
}

// Quiet boot pass: push every live / history-backed verdict home once. No UI.
async function flushAllHomeQuiet() {
  const [allVerdicts, allHistory] = await Promise.all([
    getAllVerdicts(),
    getAllHistory(),
  ]);
  const ids = new Set([
    ...allVerdicts.map((v) => v.deckId),
    ...allHistory.map((h) => h.deckId),
  ]);
  for (const deckId of ids) {
    if (!deckId) continue;
    try {
      await flushDeckHome(deckId);
    } catch { /* offline — next swipe / next open retries */ }
    await new Promise((r) => setTimeout(r, 60));
  }
}

// Small text snapshot for text-ish cards so the decision history keeps the
// actual words that were judged, even after deck files move on. Capped so a
// stray giant doc can't bloat a results file.
function cardTextSnapshot(card) {
  const kind = card.kind || '';
  let t = '';
  if (kind === 'script' || kind === 'chapter') {
    t = typeof card.media === 'string' ? card.media : (card.media && card.media.text) || '';
  } else if (kind === 'line') {
    t = [card.title, card.preview].filter(Boolean).join('\n');
  } else if (kind === 'text') {
    t = [card.title, card.preview].filter(Boolean).join('\n');
  }
  return String(t || '').slice(0, 20000);
}

function downloadJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleVerdict({ card, decision, note = '', voiceNote = '' }) {
  // Save-layer scrub: normalize the note text at the persistence chokepoint so a
  // buggy/stale client can never PERSIST garbled voice-to-text (the "stutter"
  // garble). No-op on already-clean notes.
  note = normalizeTranscript(note);
  // Verdict archive: EVERY decision
  // captures a tiny thumbnail (image media / video poster) onto the verdict —
  // keeps record "what approved looks like", rejects record "what didn't fly"
  // and why (the note). Ships out with the deck results; the consumer files keeps
  // into approved-thumbs/ and the full decision trail into swipe-history/ —
  // the minable record of the user's taste for future systems to learn from.
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
  } catch (err) {
    console.error('Failed to persist verdict:', err);
  }
  // Auto-flush home — no Sync button. Debounced so a fast streak is one POST.
  scheduleDeckFlush(verdict.deckId);
  // Phone-app feel: short haptic tap on commit. No-op on platforms that don't
  // expose navigator.vibrate (iOS Safari).
  if (navigator.vibrate) {
    try { navigator.vibrate(decision === 'keep' ? 8 : 14); } catch {}
  }
}

// Undo: erase the card's verdict(s) so it counts as undecided again. The view
// has already put the card back on top; this keeps the store in step so the
// decided-filter, tallies, and any later "Send results" all forget the slip.
async function handleUndo({ card }) {
  try {
    await deleteVerdictsForCard(card.id);
    setStatus('Undone — that one\'s back on top.');
    scheduleDeckFlush(card.deckId || (currentDeck && currentDeck.id));
  } catch (err) {
    console.error('Failed to undo verdict:', err);
    setStatus('Could not undo — see console.', 'error');
  }
}

// ── Recently Swiped review (editable) ────────────────────────────────────────
// Re-open an already-swiped deck so the user can change decisions and notes.
// Cards come from history snapshots and/or still-live store data. Each card
// shows what was picked before; Yes / Revise / No + the note bar write a new
// verdict (and update the history row).
async function openHistoryDeck(group, startCardId = null) {
  if (!group || !Array.isArray(group.items) || !group.items.length) return;
  const epoch = bumpNav();

  const rows = group.items.slice().sort((a, b) =>
    String(a.decidedAt || '').localeCompare(String(b.decidedAt || '')));
  const cards = rows.map((r) => rowToDemoCard(r, group.deckId));
  const annotations = new Map(
    rows.map((r) => [r.cardId, {
      decision: r.decision,
      note: r.note || '',
      voiceNote: r.voiceNote || '',
      historyId: r.id,
      thumb: r.thumb || '',
      row: r,
    }])
  );
  // Frozen originals for Undo — never mutate these.
  const originals = new Map(
    [...annotations.entries()].map(([id, a]) => [id, { ...a }])
  );
  let startIdx = 0;
  if (startCardId != null) {
    const i = cards.findIndex((c) => c.id === startCardId);
    if (i > 0) startIdx = i;
  }
  const reviewCards = cards.slice(startIdx);
  if (isStale(epoch)) return;

  currentDeck = {
    id: group.deckId,
    name: group.deckName,
    kind: group.kind,
    source: group.project,
    review: true,
  };
  mode = 'demo'; // popstate + back still route through the demo branch → Recently Swiped
  pickerEl.hidden = true;
  historyEl.hidden = true;
  surfaceEl.hidden = false;
  tabsEl.hidden = true;

  history.pushState({ rsView: 'demo', deckId: group.deckId }, '');

  headerSubEl.innerHTML = reviewChromeHtml({ backLabel: 'Back to Recently Swiped' });
  headerSubEl.querySelector('.rs-back').addEventListener('click', () => leaveDeck());
  wireCardSizeControls(headerSubEl);

  document.documentElement.style.setProperty('--rs-accent', kindStyle(group.kind).color);

  if (view && view.destroy) { try { view.destroy(); } catch {} }
  if (isStale(epoch)) return;
  setTagline('Review · Edit');
  view = createSwipeView(surfaceEl, {
    readOnly: false,
    annotations,
    onVerdict: (payload) => handleHistoryVerdict(payload, annotations),
    onUndo:    (payload) => handleHistoryUndo(payload, originals),
    onEmpty:   () => showReviewEnd(group),
  });
  view.setDeck(reviewCards);
  setDeckCount(reviewCards.length ? `${reviewCards.length} left` : '');
  setStatus('');
  measureCardBase();
}

// Map one Recently-Swiped row → a card the swipe-view can render. Images/video use
// the kept media/thumbnail; text-ish kinds use the saved text body.
function rowToDemoCard(r, deckId) {
  const kind = r.kind || 'text';
  const card = {
    id:      r.cardId,
    deckId:  deckId || r.deckId || '',
    kind,
    title:   r.title || '',
    preview: r.preview || '',
    caption: r.caption || '',
  };
  if (kind === 'image') {
    card.media = r.media || r.thumb || '';
  } else if (kind === 'video') {
    card.media = { src: r.media || '', poster: r.thumb || r.media || '' };
  } else if (kind === 'audio') {
    card.media = r.media || '';
  } else {
    card.media = r.content || r.preview || '';
  }
  return card;
}

async function handleHistoryVerdict({ card, decision, note = '', voiceNote = '' }, annotations) {
  note = normalizeTranscript(note);
  const thumb = await captureApprovedThumb(card);
  const deckId = card.deckId || (currentDeck && currentDeck.id) || '';
  const verdict = makeVerdict({
    cardId: card.id,
    deckId,
    decision,
    note,
    voiceNote,
    thumb,
  });
  try {
    await putVerdict(verdict);
  } catch (err) {
    console.error('Failed to persist review verdict:', err);
  }
  try {
    const prior = annotations.get(card.id);
    await upsertHistoryDecision({
      card,
      deckId,
      decision,
      note,
      voiceNote,
      thumb: thumb || (prior && prior.thumb) || '',
      prior,
    });
    annotations.set(card.id, {
      decision,
      note,
      voiceNote,
      historyId: (prior && prior.historyId) || verdict.id,
      thumb: thumb || (prior && prior.thumb) || '',
      row: prior && prior.row,
    });
  } catch (err) {
    console.error('Failed to update Recently Swiped row:', err);
  }
  scheduleDeckFlush(deckId);
  if (navigator.vibrate) {
    try { navigator.vibrate(decision === 'keep' ? 8 : 14); } catch {}
  }
}

async function handleHistoryUndo({ card }, originals) {
  try {
    await deleteVerdictsForCard(card.id);
  } catch (err) {
    console.error('Failed to undo review verdict:', err);
  }
  const orig = originals.get(card.id);
  if (orig) {
    try {
      await upsertHistoryDecision({
        card,
        deckId: card.deckId || (currentDeck && currentDeck.id) || '',
        decision: orig.decision,
        note: orig.note || '',
        voiceNote: orig.voiceNote || '',
        thumb: orig.thumb || '',
        prior: orig,
      });
      // Re-write the live verdict to the original pick so tallies / auto-flush match.
      const verdict = makeVerdict({
        cardId: card.id,
        deckId: card.deckId || (currentDeck && currentDeck.id) || '',
        decision: orig.decision,
        note: orig.note || '',
        voiceNote: orig.voiceNote || '',
        thumb: orig.thumb || '',
      });
      await putVerdict(verdict);
    } catch (err) {
      console.error('Failed to restore Recently Swiped row:', err);
    }
  }
  setStatus('Undone — that one\'s back on top.');
  scheduleDeckFlush(card.deckId || (currentDeck && currentDeck.id));
}

async function upsertHistoryDecision({ card, deckId, decision, note, voiceNote, thumb, prior }) {
  const all = await getAllHistory();
  const existing = all.find((h) => h.cardId === card.id && h.deckId === deckId)
    || all.find((h) => h.cardId === card.id)
    || (prior && prior.row)
    || null;
  const now = new Date().toISOString();
  const entry = {
    id:         (existing && existing.id) || (prior && prior.historyId) || (`hist-${deckId}-${card.id}`),
    cardId:     card.id,
    deckId,
    deckName:   (existing && existing.deckName) || (currentDeck && currentDeck.name) || '',
    project:    (existing && existing.project) || (currentDeck && currentDeck.source) || '',
    kind:       card.kind || (existing && existing.kind) || 'text',
    decision,
    title:      card.title || (existing && existing.title) || '',
    thumb:      thumb || (existing && existing.thumb) || '',
    media:      (existing && existing.media) || (typeof card.media === 'string' ? card.media : (card.media && card.media.src) || ''),
    caption:    card.caption || (existing && existing.caption) || '',
    preview:    String(card.preview || (existing && existing.preview) || '').slice(0, 280),
    content:    (existing && existing.content) || '',
    note:       note || '',
    voiceNote:  voiceNote || '',
    decidedAt:  now,
    archivedAt: (existing && existing.archivedAt) || now,
  };
  await putHistoryBatch([entry]);
}

// End of an editable review pass.
function showReviewEnd(group) {
  setDeckCount('');
  setStatus('Changes saved on this device — Sync to send them.');
  const emptyEl = surfaceEl.querySelector('.rs-empty');
  if (!emptyEl) return;
  emptyEl.innerHTML = `
    <div class="rs-demo-end">
      <div class="rs-demo-end-title">Review done</div>
      <div class="rs-demo-end-sub">Your new picks and notes are saved here. Sync to send updates.</div>
      <div class="rs-demo-end-actions">
        <button class="rs-demo-end-btn rs-demo-replay" type="button">▶ Review again</button>
        <button class="rs-demo-end-btn rs-demo-back" type="button">← Recently Swiped</button>
      </div>
    </div>
  `;
  const rep = emptyEl.querySelector('.rs-demo-replay');
  const bk  = emptyEl.querySelector('.rs-demo-back');
  if (rep) rep.addEventListener('click', () => openHistoryDeck(group, null));
  if (bk)  bk.addEventListener('click', () => leaveDeck());
}

// ── Status line ─────────────────────────────────────────────────────────────
function setDeckCount(msg) {
  const el = headerSubEl && headerSubEl.querySelector('.rs-deck-count');
  if (el) el.textContent = msg || '';
}

function setStatus(msg, tone = 'info') {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.dataset.tone = tone;
}

// The header tagline doubles as the mode label.
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
  const sync = () =>
    document.documentElement.classList.toggle('rs-offline', !navigator.onLine);
  window.addEventListener('online',  sync);
  window.addEventListener('offline', sync);
  sync();
}
