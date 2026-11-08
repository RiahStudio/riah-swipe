// Deck batch validation (schema riah-swipe.deck/1).
// Returns { ok, errors: [..], warnings: [..], deckIds: [..], cardCount }.

const KINDS = ['text', 'image', 'video', 'audio', 'script', 'line', 'chapter', 'logline'];
const ID_RE = /^[a-zA-Z0-9._-]+$/;
const WARN_FILE_BYTES = 10 * 1024 * 1024;
const ERROR_FILE_BYTES = 40 * 1024 * 1024;

export function validateBatch(batch, { filename = '', fileSizeBytes = 0 } = {}) {
  const errors = [];
  const warnings = [];
  const where = filename ? `${filename}: ` : '';
  const bytes = Number(fileSizeBytes) || 0;

  if (bytes > ERROR_FILE_BYTES) {
    errors.push(`${where}batch file is ${formatMiB(bytes)} MB; maximum is 40 MB (delivery caps at 48 MB)`);
  } else if (bytes > WARN_FILE_BYTES) {
    warnings.push(`${where}batch file is ${formatMiB(bytes)} MB; keep it under 10 MB when possible`);
  }

  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    return { ok: false, errors: [`${where}not a JSON object`], warnings, deckIds: [], cardCount: 0 };
  }

  const schema = String(batch.schema || '');
  if (!schema.startsWith('riah-swipe.deck')) {
    warnings.push(`${where}missing/unknown "schema" — expected "riah-swipe.deck/1" (loads anyway, but declare it)`);
  }

  const decks = Array.isArray(batch.decks) ? batch.decks : null;
  const cards = Array.isArray(batch.cards) ? batch.cards : null;
  if (!decks) errors.push(`${where}"decks" must be an array`);
  if (!cards) errors.push(`${where}"cards" must be an array`);
  if (!decks || !cards) return { ok: false, errors, warnings, deckIds: [], cardCount: 0 };
  if (!decks.length) errors.push(`${where}no decks in the batch`);

  const deckIds = [];
  for (const d of decks) {
    if (!d || typeof d !== 'object') { errors.push(`${where}a deck entry is not an object`); continue; }
    if (!d.id)   errors.push(`${where}deck missing "id"`);
    else if (!ID_RE.test(d.id)) errors.push(`${where}deck id "${d.id}" has unsafe characters (use letters, digits, . _ -)`);
    else deckIds.push(d.id);
    if (!d.name) errors.push(`${where}deck "${d.id || '?'}" missing "name"`);
    if (d.kind && !KINDS.includes(d.kind)) {
      warnings.push(`${where}deck "${d.id}" kind "${d.kind}" is unknown — it will render as text`);
    }
    if (!d.returnTo && !d.source) {
      warnings.push(`${where}deck "${d.id}" has no "returnTo"/"source" — the results file won't say where to route`);
    }
  }

  let cardCount = 0;
  const cardIds = new Set();
  for (const c of cards) {
    if (!c || typeof c !== 'object') { errors.push(`${where}a card entry is not an object`); continue; }
    cardCount++;
    if (!c.id)     errors.push(`${where}card missing "id"`);
    else if (cardIds.has(c.id)) errors.push(`${where}duplicate card id "${c.id}"`);
    else cardIds.add(c.id);
    if (!c.deckId) errors.push(`${where}card "${c.id || '?'}" missing "deckId"`);
    else if (!deckIds.includes(c.deckId)) {
      errors.push(`${where}card "${c.id || '?'}" points at deck "${c.deckId}" which isn't in this batch`);
    }
    if (!c.title) errors.push(`${where}card "${c.id || '?'}" missing "title"`);
    if (c.kind && !KINDS.includes(c.kind)) {
      warnings.push(`${where}card "${c.id}" kind "${c.kind}" is unknown — it will render as text`);
    }
    if ((c.kind === 'image' || c.kind === 'video' || c.kind === 'audio') && !c.media) {
      warnings.push(`${where}card "${c.id}" is ${c.kind} but has no "media"`);
    }
  }

  for (const id of deckIds) {
    if (!cards.some((c) => c && c.deckId === id)) {
      warnings.push(`${where}deck "${id}" has zero cards — it won't appear in the picker`);
    }
  }

  for (const id of deckIds) {
    const count = cards.filter((c) => c && c.deckId === id).length;
    if (count > 100) {
      warnings.push(`${where}deck "${id}" has ${count} cards; split decks over 100 cards for reliable review and delivery`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, deckIds, cardCount };
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}
