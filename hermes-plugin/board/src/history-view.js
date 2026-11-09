// src/history-view.js
// "Recently Swiped" archive — a scrollable mobile-first list of decided cards
// grouped by deck, with thumbnails and verdict badges. Tap a deck (or any of its
// cards) to REVIEW it and change decisions or notes (via onOpenDeck).
//
// Data comes from two sources, merged into one timeline:
//   1. The `history` store — verdict snapshots from purged decks
//   2. Live verdicts + cards — from decks still in the store (not yet archived)
//
// Public API:
//   const view = createHistoryView(rootEl, { onOpenDeck });
//   await view.refresh();   // re-query and render
//   view.destroy();         // cleanup
//   onOpenDeck(group, startCardId|null) — fired when a deck/card is tapped to review

import {
  getAllHistory,
  getAllVerdicts,
  getAllDecks,
  getAllCards,
  clearHistory,
  getDismissedHistoryIds,
  dismissHistoryItem,
  restoreHistoryItem,
} from './data/store.js';

export function createHistoryView(root, { onOpenDeck } = {}) {
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'rs-history';
  root.appendChild(wrap);

  async function refresh() {
    // ── Gather both data sources ──────────────────────────────────────────
    const [histEntries, liveVerdicts, decks, cards, dismissed] = await Promise.all([
      getAllHistory(),
      getAllVerdicts(),
      getAllDecks(),
      getAllCards(),
      getDismissedHistoryIds(),
    ]);

    // Build lookup maps for live data
    const deckMap = new Map(decks.map((d) => [d.id, d]));
    const cardMap = new Map(cards.map((c) => [c.id, c]));

    // ── Normalize live verdicts into the same shape as history entries ────
    // Latest verdict per card (deduplicate the append-only log)
    const latestLive = new Map();
    for (const v of liveVerdicts) {
      const prev = latestLive.get(v.cardId);
      if (!prev || v.decidedAt > prev.decidedAt) latestLive.set(v.cardId, v);
    }

    const liveRows = [];
    for (const [cardId, v] of latestLive) {
      const card = cardMap.get(cardId);
      const deck = deckMap.get(v.deckId);
      if (!card) continue; // orphaned verdict
      const mediaSrc = typeof card.media === 'string' ? card.media
        : (card.media && (card.media.src || card.media.poster)) || '';
      liveRows.push({
        id:         v.id,
        cardId,
        deckId:     v.deckId,
        deckName:   (deck && deck.name) || v.deckId,
        project:    (deck && deck.source) || '',
        kind:       card.kind || (deck && deck.kind) || 'text',
        decision:   v.decision,
        title:      card.title || '',
        thumb:      v.thumb || '',
        media:      mediaSrc,
        caption:    card.caption || '',
        preview:    String(card.preview || '').slice(0, 280),
        content:    textBodyOf(card),       // full-ish text body for a faithful replay
        note:       v.note || '',           // the note the user took (shown in the demo)
        voiceNote:  v.voiceNote || '',
        decidedAt:  v.decidedAt,
        archivedAt: '',  // not archived yet
      });
    }

    // ── Merge: history entries + live rows, deduplicate by verdict id ─────
    // Dismissed rows (the user removed them from Recently Swiped) are filtered
    // out here regardless of source — a stored history row OR a still-live verdict.
    const seen = new Set();
    const all = [];
    for (const row of [...histEntries, ...liveRows]) {
      if (seen.has(row.id)) continue;
      if (dismissed.has(row.id)) continue;
      seen.add(row.id);
      all.push(row);
    }

    // Sort newest first
    all.sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));

    // ── Group by deck ────────────────────────────────────────────────────
    const groups = new Map(); // deckId → { deckName, project, kind, items[] }
    for (const row of all) {
      if (!groups.has(row.deckId)) {
        groups.set(row.deckId, {
          deckId:   row.deckId,
          deckName: row.deckName,
          project:  row.project,
          kind:     row.kind,
          items:    [],
          // Use the most recent decidedAt as the group timestamp
          latestAt: row.decidedAt,
        });
      }
      groups.get(row.deckId).items.push(row);
    }

    // Sort groups by most recently decided
    const sortedGroups = [...groups.values()].sort(
      (a, b) => (b.latestAt || '').localeCompare(a.latestAt || '')
    );

    // ── Render ───────────────────────────────────────────────────────────
    wrap.innerHTML = '';

    if (sortedGroups.length === 0) {
      wrap.innerHTML = `
        <div class="rs-history-empty">
          <div class="rs-history-empty-glyph">📋</div>
          <div class="rs-history-empty-title">No swipe history yet</div>
          <div class="rs-history-empty-sub">Cards you review will show up here.</div>
        </div>
      `;
      return;
    }

    for (const group of sortedGroups) {
      const section = document.createElement('div');
      section.className = 'rs-history-group';

      // Group header
      const header = document.createElement('div');
      header.className = 'rs-history-group-head';
      const ks = kindMeta(group.kind);
      const ts = friendlyTime(group.latestAt);
      const tally = tallyDecisions(group.items);
      header.innerHTML = `
        <div class="rs-history-group-top">
          <span class="rs-history-kind-pill" style="background:${ks.color}">${ks.glyph} ${esc(ks.label)}</span>
          ${group.project ? `<span class="rs-history-project">${esc(group.project)}</span>` : ''}
        </div>
        <div class="rs-history-group-name">${esc(group.deckName)}</div>
        <div class="rs-history-group-meta">
          <span class="rs-history-time">${esc(ts)}</span>
          <span class="rs-history-tally">
            ${tally.keep ? `<span class="rs-ht-keep">${tally.keep}✓</span>` : ''}
            ${tally.revise ? `<span class="rs-ht-revise">${tally.revise}▣</span>` : ''}
            ${tally.discard ? `<span class="rs-ht-discard">${tally.discard}✕</span>` : ''}
          </span>
        </div>
      `;

      // Tap the deck header to review & change picks.
      // The × dismiss is a separate sibling node, so clearing a deck never triggers
      // a review open.
      if (typeof onOpenDeck === 'function') {
        header.classList.add('rs-history-group-open');
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.title = 'Review this deck — change decisions or notes';
        const openReview = () => onOpenDeck(group, null);
        header.addEventListener('click', openReview);
        header.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReview(); }
        });
        const meta = header.querySelector('.rs-history-group-meta');
        if (meta) {
          const replay = document.createElement('span');
          replay.className = 'rs-history-replay';
          replay.textContent = '✎ Review';
          meta.appendChild(replay);
        }
      }
      section.appendChild(header);

      // Whole-deck dismiss (×): clears this entire deck out of Recently Swiped
      // for good, with Undo. (the user clears by deck here, not card-by-card.)
      const gx = document.createElement('button');
      gx.type = 'button';
      gx.className = 'rs-history-group-dismiss';
      gx.setAttribute('aria-label', `Remove ${group.deckName} from Recently Swiped`);
      gx.title = 'Clear this deck from Recently Swiped';
      gx.textContent = '×';
      gx.addEventListener('click', () => dismissGroup(group, section));
      section.appendChild(gx);

      // Card grid
      const grid = document.createElement('div');
      grid.className = 'rs-history-grid';
      for (const item of group.items) {
        grid.appendChild(renderHistoryCard(item, group));
      }
      section.appendChild(grid);

      wrap.appendChild(section);
    }
  }

  function renderHistoryCard(item, group) {
    const el = document.createElement('div');
    el.className = 'rs-history-card';

    // Per-card verdict badges removed: the red ✕ on cut
    // cards read as a delete button. Recently Swiped is now a clean thumbnail
    // grid per deck; clearing happens at the DECK level (the group × only).
    const hasThumb = item.thumb || (item.kind === 'image' && item.media);
    const thumbSrc = item.thumb || item.media || '';

    if (hasThumb) {
      el.innerHTML = `
        <div class="rs-history-thumb">
          <img src="${esc(thumbSrc)}" alt="" loading="lazy" draggable="false">
        </div>
        <div class="rs-history-card-label">${esc(truncate(item.title, 28))}</div>
      `;
    } else {
      // Text/script/line/audio — no image, show a text card
      el.classList.add('rs-history-card-text');
      el.innerHTML = `
        <div class="rs-history-text-body">
          <span class="rs-history-text-title">${esc(truncate(item.title, 40))}</span>
          ${item.preview ? `<span class="rs-history-text-preview">${esc(truncate(item.preview, 60))}</span>` : ''}
        </div>
      `;
    }

    // Tap a card to review from here — change decision or note.
    if (typeof onOpenDeck === 'function' && group) {
      el.classList.add('rs-history-card-open');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.title = 'Review from here — change decision or note';
      const openHere = () => onOpenDeck(group, item.cardId);
      el.addEventListener('click', openHere);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHere(); }
      });
    }
    return el;
  }

  // Clear an ENTIRE deck out of Recently Swiped for good (with Undo). the user
  // reviews by deck here, not card-by-card — he clears whole decks he'll never
  // need again (e.g. internal-tool art). Removes the section, dismisses every
  // row in the group, and offers a one-tap restore of the whole deck.
  async function dismissGroup(group, section) {
    section.remove();
    const removed = [];
    for (const item of group.items) {
      try { removed.push({ id: item.id, row: await dismissHistoryItem(item.id) }); }
      catch (e) { console.error('Recently Swiped group dismiss failed:', e); }
    }
    if (!wrap.querySelector('.rs-history-group')) refresh();   // last deck gone → empty state
    showUndoToast(`Removed “${group.deckName}”`, async () => {
      for (const r of removed) {
        try { await restoreHistoryItem(r.id, r.row); } catch (e) { console.error('Undo failed:', e); }
      }
      await refresh();
    });
  }

  function destroy() {
    wrap.innerHTML = '';
    root.innerHTML = '';
  }

  return { refresh, destroy };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function verdictBadge(decision) {
  switch (decision) {
    case 'keep':    return { glyph: '✓', cls: 'rs-history-badge-keep' };
    case 'revise':  return { glyph: '▣', cls: 'rs-history-badge-revise' };
    case 'discard': return { glyph: '✕', cls: 'rs-history-badge-discard' };
    default:        return { glyph: '?', cls: '' };
  }
}

const KIND_META = {
  image:   { color: '#3fbf7f', glyph: '🖼️', label: 'images'  },
  video:   { color: '#5ba0d9', glyph: '🎬', label: 'video'   },
  audio:   { color: '#e0a93c', glyph: '🎙️', label: 'audio'   },
  script:  { color: '#a78bfa', glyph: '📜', label: 'script'  },
  chapter: { color: '#d98a5b', glyph: '📖', label: 'chapter' },
  line:    { color: '#e87fa8', glyph: '💬', label: 'lines'   },
  text:    { color: '#94a3b8', glyph: '📝', label: 'text'    },
};

function kindMeta(kind) {
  return KIND_META[kind] || KIND_META.text;
}

function tallyDecisions(items) {
  const t = { keep: 0, revise: 0, discard: 0 };
  for (const i of items) t[i.decision] = (t[i.decision] || 0) + 1;
  return t;
}

function friendlyTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  // Older than a week — show the date
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Full-ish text body for a live card so the replay demo shows the real words for
// script/chapter/line/text kinds (image/video carry their media src instead).
// Capped to match the purge-time snapshot. (Replay demo, 2026-06-22.)
function textBodyOf(card) {
  const kind = (card && card.kind) || '';
  let t = '';
  if (kind === 'script' || kind === 'chapter') {
    t = typeof card.media === 'string' ? card.media : (card.media && card.media.text) || '';
  } else if (kind === 'line' || kind === 'text') {
    t = [card.title, card.preview].filter(Boolean).join('\n');
  }
  return String(t || '').slice(0, 4000);
}

function truncate(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Undo toast (shared floating snackbar) ─────────────────────────────────────
// One reusable bottom snackbar with an Undo button, reused across dismisses;
// auto-hides after a few seconds. The data is already gone by then — the toast
// is purely the "oops, bring it back" safety net.
let _undoTimer = null;
function showUndoToast(message, onUndo) {
  let toast = document.getElementById('rs-undo-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rs-undo-toast';
    toast.className = 'rs-undo-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'rs-undo-toast-msg';
  msg.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rs-undo-toast-btn';
  btn.textContent = 'Undo';
  toast.appendChild(msg);
  toast.appendChild(btn);
  void toast.offsetWidth;   // reflow so the slide-in runs even on rapid repeats
  toast.classList.add('rs-undo-toast-show');
  clearTimeout(_undoTimer);
  const hide = () => toast.classList.remove('rs-undo-toast-show');
  btn.addEventListener('click', async () => {
    clearTimeout(_undoTimer);
    hide();
    try { await onUndo(); } catch (e) { console.error('Undo failed:', e); }
  });
  _undoTimer = setTimeout(hide, 6000);
}
