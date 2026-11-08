// src/swipe-view.js
// Interaction + presentation layer for the swipe surface.
//
// One responsibility: render a stack of cards, accept pointer/touch input, and
// emit a verdict ('keep' | 'revise' | 'discard'). Keep/discard ride the
// left/right gestures; revise ("partially right, needs another pass") is button-only.
// The view does not know about IndexedDB or decks-on-disk — it knows about Cards.
// The card BODY renders polymorphically per card.kind (image / video / audio /
// script / line / text) — adding a new kind is a small change here plus a CSS rule.
//
// Public API:
//   const view = createSwipeView(rootEl, { onVerdict, onUndo, onEmpty });
//   view.setDeck(cards);                  // replace deck, re-render
//   view.destroy();                       // cleanup listeners
//
// READ-ONLY mode: pass { readOnly: true, annotations, onEmpty } to replay an
// already-decided deck (each card shows the original decision + note; gestures
// and buttons animate but onVerdict is never called, nothing persists).
//
// EDITABLE REVIEW: pass { readOnly: false, annotations, onVerdict, onUndo } to
// re-decide a deck you've already been through — each card shows what you picked
// last time, the note bar is prefilled with the note you left, and swiping writes
// a new verdict over the old one. Annotations drive the "what did I say before"
// chrome independently of readOnly, so both modes share one code path.

const SWIPE_THRESHOLD = 110;   // px — past this, releasing commits a verdict
const ROTATION_FACTOR = 0.08;  // degrees per px while dragging
const MAX_STACK       = 3;     // how many cards render in the stack

// ── normalizeTranscript — whitespace tidy ONLY (no word edits) ────────────────
// Collapses runs of spaces and trims — nothing else. It NEVER removes, dedups,
// or rewrites words: a note is saved exactly as spoken or typed, including
// legitimate repeats. Do NOT add word- or phrase-collapsing here; a brainless
// de-dup would delete real words, which is worse than any stutter.
export function normalizeTranscript(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

export function createSwipeView(root, { onVerdict, onUndo, onEmpty, readOnly = false, annotations = null } = {}) {
  // ── State ────────────────────────────────────────────────────────────────
  const annotFor = (id) => {
    if (!annotations || id == null) return null;
    return typeof annotations.get === 'function' ? (annotations.get(id) || null) : (annotations[id] || null);
  };
  let deck = [];
  let started = false;   // set by setDeck — onEmpty must NEVER fire before a deck
                         // is actually loaded. (Inherited hard lesson: an onEmpty
                         // fired from the creation-time render() was once read as
                         // "deck finished" upstream and purged every deck on open.
                         // The guard stays. Do not remove it.)
  let dragging = false;
  let dx = 0;
  let startX = 0;
  let pointerId = null;
  let topEl = null;
  let history = [];   // decisions this session, newest last — powers Undo. Each
                      // entry is { card, note, voiceNote } so undo can hand the
                      // note that rode the decision back to the bar.
  let prefilled = ''; // what render() last auto-filled the bar with — lets undo
                      // tell auto-fill apart from text the user actually typed
  let pendingTimer = null, pendingCardId = null;   // the in-flight exit animation
  let lastVerdictPromise = Promise.resolve();     // last persist — must finish before onEmpty
  let deckTotal = 0;     // card count when the deck was set (incl. already-decided) — the T in N/T

  // ── DOM scaffold ─────────────────────────────────────────────────────────
  root.classList.add('rs-swipe-root');
  root.classList.toggle('rs-swipe-readonly', !!readOnly);
  root.innerHTML = `
    <div class="rs-stack" aria-live="polite"></div>
    <div class="rs-empty" hidden>
      <div class="rs-empty-glyph">∅</div>
    </div>
    <div class="rs-note">
      <button class="rs-mic" type="button" aria-label="Record a voice note (turns into text)" title="Record a voice note — your words land here as text, then pick Yes / Revise / No">🎤</button>
      <input class="rs-note-text" type="text" placeholder="Note for your next decision… (or tap the mic)" aria-label="Typed note">
      <span class="rs-note-status" aria-live="polite"></span>
    </div>
    <div class="rs-actions">
      <button class="rs-btn rs-undo" type="button" aria-label="Undo last decision" title="Take back the last decision — the card comes back on top" disabled>
        <span aria-hidden="true"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 4L3 8l4 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 8h7.5a5.5 5.5 0 1 1 0 11H8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span>
      </button>
      <button class="rs-btn rs-btn-discard" type="button" aria-label="No">
        <span aria-hidden="true"><svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span><span class="rs-btn-label">No</span>
      </button>
      <button class="rs-btn rs-btn-revise" type="button" aria-label="Partially right — needs another pass" title="Revise — partially right, needs another pass">
        <span aria-hidden="true"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 10a6 6 0 1 1-2.1-4.56" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M16.4 3v3.4H13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="rs-btn-label">Revise</span>
      </button>
      <button class="rs-btn rs-btn-keep" type="button" aria-label="Yes">
        <span aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10.5l4.2 4L16 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="rs-btn-label">Yes</span>
      </button>
    </div>
  `;
  const copyBtn   = mountChromeCopy();
  const stackEl   = root.querySelector('.rs-stack');
  // Card-position counter "N/T", bottom-right of the card stage. A zero-height
  // strip between stack and note bar, so it never overlaps the buttons; styled
  // inline (no stylesheet dependency). Null-safe for test stubs.
  let posEl = null, posTxt = null;
  try {
    posEl = document.createElement('div');
    posTxt = document.createElement('span');
    posEl.className = 'rs-pos';
    posEl.setAttribute('aria-hidden', 'true');
    posEl.style.cssText = 'position:relative;height:0;z-index:5;pointer-events:none;';
    posTxt.style.cssText = 'position:absolute;right:16px;bottom:2px;font:10px/1 var(--font-mono,ui-monospace,Menlo,Consolas,monospace);letter-spacing:.08em;color:var(--dim,#77777F);pointer-events:none;';
    posEl.appendChild(posTxt);
    stackEl.after(posEl);
    posEl.hidden = true;
  } catch { posEl = null; posTxt = null; }
  const emptyEl   = root.querySelector('.rs-empty');
  const noteEl    = root.querySelector('.rs-note');
  const actionsEl = root.querySelector('.rs-actions');
  wireChromeCopy(copyBtn);
  const keepBtn   = root.querySelector('.rs-btn-keep');
  const discBtn   = root.querySelector('.rs-btn-discard');
  const reviseBtn = root.querySelector('.rs-btn-revise');
  const undoBtn   = root.querySelector('.rs-undo');
  const micBtn    = root.querySelector('.rs-mic');
  const noteInput = root.querySelector('.rs-note-text');
  const noteStat  = root.querySelector('.rs-note-status');

  keepBtn.addEventListener('click', () => commit('keep'));
  discBtn.addEventListener('click', () => commit('discard'));
  reviseBtn.addEventListener('click', () => commit('revise'));
  undoBtn.addEventListener('click', undoLast);

  // Tap/click a card image → full-screen, scrollable + pinch-zoomable view.
  root.addEventListener('click', (e) => {
    const img = e.target.closest('.rs-card-media img');
    if (!img || !img.src) return;
    e.preventDefault();
    e.stopPropagation();
    openLightbox(img.currentSrc || img.src, img.alt || '');
  });
  function openLightbox(src, alt) {
    let lb = document.getElementById('rs-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'rs-lightbox';
      lb.className = 'rs-lightbox';
      lb.innerHTML = '<img alt=""><button class="rs-lightbox-close" type="button" aria-label="Close">✕</button><div class="rs-lightbox-hint">tap to close · pinch or ctrl/⌘-scroll to zoom</div>';
      document.body.appendChild(lb);
      const close = () => lb.classList.remove('rs-lightbox-on');
      lb.addEventListener('click', close);
      lb.querySelector('.rs-lightbox-close').addEventListener('click', (ev) => { ev.stopPropagation(); close(); });
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    }
    const im = lb.querySelector('img');
    im.src = src;
    im.alt = alt || '';
    lb.classList.add('rs-lightbox-on');
  }

  // ── Notes (typed + voice) ──────────────────────────────────────────────────
  // A note (typed text and/or a spoken note) attaches to whichever card is on
  // top when you decide — the note NEVER implies a verdict. Speak a note, then
  // hit Yes / Revise / No (or swipe): the same note rides any of them. The bar
  // clears after each decision.
  //
  // Voice notes transcribe to TEXT on the device via the browser's speech
  // recognition where available (Chrome/Edge/Safari on localhost). Where it
  // isn't (Firefox/Brave, or a phone over plain LAN http — not a secure
  // context), falls back to an audio-memo recording, and where even that is
  // blocked, says plainly: type the note.
  let voiceNote = '';            // data-URI of the recorded clip, '' if none
  let recorder  = null, chunks = [], recording = false, micStream = null;
  let recog = null, recognizing = false, recogBase = '';
  let voiceTextUnsupported = false;

  micBtn.addEventListener('click', toggleRecord);

  async function toggleRecord() {
    if (recognizing) { stopRecognition(); return; }
    if (recording) { stopRecord(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && !voiceTextUnsupported && window.isSecureContext) { startRecognition(SR); return; }
    voiceTextUnsupported = true;
    await startLegacyRecord();
  }

  // ── Voice → text (preferred path) ──────────────────────────────────────────
  function startRecognition(SR) {
    recog = new SR();
    recog.lang = navigator.language || 'en-US';
    recog.continuous = true;
    recog.interimResults = true;
    recogBase = noteInput.value ? noteInput.value.replace(/\s+$/, '') + ' ' : '';
    let finals = '';
    recog.addEventListener('result', (e) => {
      let interim = '';
      finals = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += r[0].transcript;
        else interim += r[0].transcript;
      }
      noteInput.value = normalizeTranscript(recogBase + finals + interim);
    });
    recog.addEventListener('error', (e) => {
      const err = (e && e.error) || '';
      endRecognitionUI(false);
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        noteStat.textContent = 'mic blocked — type a note instead';
      } else {
        voiceTextUnsupported = true;
        startLegacyRecord();
      }
    });
    recog.addEventListener('end', () => endRecognitionUI(true));
    try { recog.start(); } catch { startLegacyRecord(); return; }
    recognizing = true;
    micBtn.classList.add('rs-mic-on');
    micBtn.textContent = '■';
    noteStat.textContent = 'listening… tap to stop';
  }

  function stopRecognition() {
    if (recog && recognizing) { try { recog.stop(); } catch {} }
  }

  function endRecognitionUI(showDone) {
    if (!recognizing) return;
    recognizing = false;
    micBtn.classList.remove('rs-mic-on');
    micBtn.textContent = '🎤';
    noteStat.textContent = showDone && noteInput.value
      ? 'voice note captured as text ✓ — now pick Yes / Revise / No'
      : '';
  }

  // ── Audio memo (fallback path) ──────────────────────────────────────────────
  async function startLegacyRecord() {
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      noteStat.textContent = 'voice needs the desktop — type a note here'; return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      noteStat.textContent = 'mic blocked — type a note instead'; return;
    }
    chunks = [];
    try { recorder = new MediaRecorder(micStream); }
    catch { noteStat.textContent = 'cannot record here — type a note'; stopStream(); return; }
    recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', finishRecord);
    recorder.start();
    recording = true;
    micBtn.classList.add('rs-mic-on');
    micBtn.textContent = '■';
    noteStat.textContent = voiceTextUnsupported
      ? 'recording audio note (no live text in this browser)… tap to stop'
      : 'recording… tap to stop';
  }

  function stopRecord() {
    if (recorder && recording) { try { recorder.stop(); } catch {} }
  }

  function finishRecord() {
    recording = false;
    micBtn.classList.remove('rs-mic-on');
    micBtn.textContent = '🎤';
    stopStream();
    const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
    const fr = new FileReader();
    fr.onload = () => {
      voiceNote = String(fr.result || '');
      const why = voiceTextUnsupported
        ? ' — saved as audio (no speech-to-text in this browser)'
        : '';
      noteStat.innerHTML = '🎙 voice note ✓' + why + ' <button class="rs-note-clear" type="button" aria-label="Clear voice note">×</button>';
      const clr = noteStat.querySelector('.rs-note-clear');
      if (clr) clr.addEventListener('click', clearVoice);
    };
    fr.readAsDataURL(blob);
  }

  function clearVoice() { voiceNote = ''; noteStat.textContent = ''; }
  function stopStream() { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } }

  function takeNote() {
    if (recognizing) stopRecognition();
    const note = (noteInput.value || '').trim();
    // Text wins over audio: when there's a typed/dictated note, drop the bulky
    // audio clip — the words are enough. Audio is only kept when there are NO words.
    const vn = note ? '' : voiceNote;
    noteInput.value = '';
    voiceNote = '';
    noteStat.textContent = '';
    if (recording) stopRecord();
    return { note, voiceNote: vn };
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function render() {
    stackEl.innerHTML = '';
    const visible = deck.slice(0, MAX_STACK);
    if (visible.length === 0) {
      emptyEl.hidden = false;
      // Done state: clear the swiping chrome so the finish panel stands alone.
      copyBtn.hidden = true;
      if (posEl) posEl.hidden = true;
      noteEl.hidden = true;
      actionsEl.hidden = true;
      keepBtn.disabled = true;
      discBtn.disabled = true;
      reviseBtn.disabled = true;
      if (started && typeof onEmpty === 'function') onEmpty();
      topEl = null;
      return;
    }
    emptyEl.hidden = true;
    if (posEl && posTxt) {
      // N = 1-based place of the card on screen; T fixed at setDeck, so it counts
      // already-swiped cards. Undo re-adds the card, which steps N back.
      const total = Math.max(deckTotal, deck.length);
      posTxt.textContent = `${total - deck.length + 1}/${total}`;
      posEl.hidden = false;
    }
    syncChromeCopy(visible[0]);
    noteEl.hidden = readOnly;
    actionsEl.hidden = false;
    keepBtn.disabled = false;
    discBtn.disabled = false;
    reviseBtn.disabled = false;

    // Prefill the note from the prior decision when re-reviewing a decided deck,
    // so you can adjust what you said instead of retyping it. Read-only replay
    // leaves the bar alone (nothing there is writable).
    if (!readOnly && annotations && visible[0]) {
      const prior = annotations.get(visible[0].id);
      noteInput.value = (prior && prior.note) || '';
      noteStat.textContent = '';
      prefilled = noteInput.value;
    } else if (!readOnly) {
      noteInput.value = '';
      prefilled = '';
    }

    visible.slice().reverse().forEach((card, i, arr) => {
      const offset = arr.length - 1 - i;
      const el = renderCard(card, offset, deck.length);
      stackEl.appendChild(el);
      if (offset === 0) {
        topEl = el;
        attachPointerHandlers(topEl);
      }
    });
    updateTransform(0);
  }

  function renderCard(card, offset, remaining) {
    const kind = card.kind || 'text';
    const el = document.createElement('article');
    // Keyed off annotations, not readOnly: a card wears the "prior decision"
    // treatment whenever there IS a prior decision to show — which is what lets
    // editable review reuse this path instead of forking it.
    el.className = `rs-card rs-card-kind-${kind}${annotations && annotations.has(card.id) ? ' rs-card-demo' : ''}`;
    el.dataset.offset = String(offset);
    el.style.setProperty('--rs-stack-offset', String(offset));
    const visual = kind === 'image' || kind === 'video';
    // Script/chapter/logline: body only — no tag pill. Agent tags ("scheme · 🟢")
    // were sitting on top of the pitch and getting in the way.
    const bare = visual || kind === 'script' || kind === 'chapter' || kind === 'logline';
    el.innerHTML = `
      ${!bare && card.tag ? `<div class="rs-card-head"><span class="rs-card-tag">${esc(card.tag)}</span></div>` : ''}
      ${renderBody(card)}
      ${annotations && annotations.has(card.id) ? renderAnnot(card) : ''}
      ${bare ? '' : `<div class="rs-card-foot"><span class="rs-card-count">${remaining} left</span></div>`}
      <div class="rs-overlay rs-overlay-keep"    aria-hidden="true">KEEP</div>
      <div class="rs-overlay rs-overlay-discard" aria-hidden="true">DISCARD</div>
    `;
    return el;
  }

  // ── Body renderers per kind ──────────────────────────────────────────────
  function renderBody(card) {
    switch (card.kind) {
      case 'image':   return renderImageBody(card);
      case 'video':   return renderVideoBody(card);
      case 'audio':   return renderAudioBody(card);
      case 'script':  return renderScriptBody(card);
      case 'chapter': return renderScriptBody(card);  // chapters read like scripts
      case 'line':    return renderLineBody(card);
      case 'logline': return renderLoglineBody(card);
      default:        return renderTextBody(card);
    }
  }

  function renderAudioBody(card) {
    const media = card.media || {};
    const src   = typeof media === 'string' ? media : media.src || '';
    const mime  = typeof media === 'object' && media.mime ? media.mime : 'audio/mpeg';
    const line  = (card.meta && card.meta.line) ? card.meta.line : '';
    return `
      <div class="rs-card-audio">
        <div class="rs-audio-glyph" aria-hidden="true">♪</div>
        <h2 class="rs-card-title rs-card-title-compact">${esc(card.title)}</h2>
        ${line ? `<blockquote class="rs-audio-line">${esc(line)}</blockquote>` : ''}
        ${src ? `<audio class="rs-audio-player" controls preload="metadata">
                   <source src="${esc(src)}" type="${esc(mime)}">
                 </audio>` : `<p class="rs-card-preview">Audio not loaded yet.</p>`}
        ${card.preview ? `<p class="rs-card-preview">${esc(card.preview)}</p>` : ''}
      </div>
    `;
  }

  function renderImageBody(card) {
    const src = mediaSrc(card.media);
    return `
      <div class="rs-card-media">
        ${src ? `<img src="${esc(src)}" alt="" loading="lazy" draggable="false">` : ''}
      </div>
      ${captionLine(card)}
    `;
  }

  /**
   * The label under a picture: one quiet line, title then caption.
   *
   * from four mockups. It is deliberately NOT a panel —
   * every previous attempt boxed this text with its own background and border, which
   * reads as a second frame around the artwork and is what kept making these look
   * wrong ("two frames is killing us" → "no frame at all", 2026-07-15). A single
   * hairline rule and dim type carries the same information and disappears.
   *
   * It also sits OUTSIDE .rs-card-media now. That is what fixes the side-by-side bug
   * at the root: the media box centres its child, so it must only ever have one.
   */
  function captionLine(card) {
    const title = String(card.title || '').trim();
    const cap = typeof card.caption === 'string' ? card.caption.trim() : '';
    if (!title && !cap) return '';
    const parts = [
      title ? `<b>${esc(title)}</b>` : '',
      cap ? esc(cap) : '',
    ].filter(Boolean).join(' · ');
    return `<p class="rs-card-capline">${parts}</p>`;
  }

  function renderVideoBody(card) {
    const media  = card.media || {};
    const src    = typeof media === 'string' ? media : media.src    || '';
    const poster = typeof media === 'object' ? media.poster || ''   : '';
    const mime   = typeof media === 'object' ? media.mime   || 'video/mp4' : 'video/mp4';
    const body = src
      ? `<video controls preload="metadata" playsinline ${poster ? `poster="${esc(poster)}"` : ''}>
           <source src="${esc(src)}" type="${esc(mime)}">
         </video>`
      : `${poster ? `<img src="${esc(poster)}" alt="" loading="lazy" draggable="false">` : ''}
         <div class="rs-play-glyph" aria-hidden="true">▶</div>`;
    return `
      <div class="rs-card-media ${src ? '' : 'rs-card-media-poster'}">
        ${body}
      </div>
      ${captionLine(card)}
    `;
  }

  function renderScriptBody(card) {
    // Script/chapter: the body IS the card. No title/preview chrome under (or
    // above) the text — that reprint made long decks look like a second essay
    // taped under the script. Title stays on the card for copy/history; it just
    // doesn't paint on the review surface.
    const text = typeof card.media === 'string'
      ? card.media
      : (card.media && card.media.text) || '';
    return `<pre class="rs-card-script">${esc(text)}</pre>`;
  }

  function renderLineBody(card) {
    return `
      <blockquote class="rs-card-line-quote">${esc(card.title)}</blockquote>
      ${card.preview ? `<p class="rs-card-preview rs-card-preview-bottom">${esc(card.preview)}</p>` : ''}
    `;
  }

  function renderLoglineBody(card) {
    // Logline body lives in `preview` (Loglines desk) OR `media` as a string
    // (pitch decks like cm-shorts). Title stays off the review surface — the
    // pitch is the only thing to judge. Still in Copy.
    const body = String(card.preview || '').trim()
      || (typeof card.media === 'string' ? card.media : (card.media && card.media.text) || '')
      || '';
    return `<p class="rs-card-preview">${esc(body)}</p>`;
  }

  function renderTextBody(card) {
    return `
      <h2 class="rs-card-title">${esc(card.title)}</h2>
      <p class="rs-card-preview">${esc(card.preview || '')}</p>
    `;
  }

  // Prior decision + note, rendered ON the card. Shown in read-only replay AND
  // in editable review — when you're about to re-decide something, what you said
  // last time is the most useful thing on screen.
  function renderAnnot(card) {
    const a = annotFor(card.id);
    if (!a) return '';
    const M = {
      keep:    { label: 'Kept',   cls: 'keep' },
      revise:  { label: 'Revise', cls: 'revise' },
      discard: { label: 'Cut',    cls: 'discard' },
    };
    const d = M[a.decision] || { label: String(a.decision || '—'), cls: 'none' };
    const note  = (a.note || '').trim();
    const audio = (!note && a.voiceNote) ? a.voiceNote : '';
    // "Decision" when replaying a closed deck; "Was" when you're about to change it.
    const lead  = readOnly ? 'Decision' : 'Was';
    return `
      <div class="rs-demo-annot rs-demo-annot-${d.cls}">
        <span class="rs-demo-verdict">${lead}: ${esc(d.label)}</span>
        ${note ? `<span class="rs-demo-note">“${esc(note)}”</span>` : ''}
        ${audio ? `<audio class="rs-demo-audio" controls preload="none" src="${esc(audio)}"></audio>` : ''}
      </div>
    `;
    // Deliberately no "no note taken" placeholder (removed 2026-07-28). Most decisions
    // carry no note, so it fired constantly and told the reviewer nothing they could act
    // on — the verdict alone already says everything. Empty states earn their space or
    // they don't appear.
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function mediaSrc(media) {
    if (!media) return '';
    if (typeof media === 'string') return media;
    return media.src || media.poster || '';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
    );
  }

  // ── Copy text ─────────────────────────────────────────────────────────────
  // Text cards get Copy on the Back row — not a band above the stack
  //.
  const NON_TEXT_KINDS = ['image', 'video', 'audio'];
  function isTextCard(card) {
    return !NON_TEXT_KINDS.includes((card && card.kind) || 'text');
  }
  function mountChromeCopy() {
    const btn = document.createElement('button');
    btn.className = 'rs-card-copy';
    btn.type = 'button';
    btn.hidden = true;
    btn.setAttribute('aria-label', 'Copy this text to the clipboard');
    btn.title = 'Copy the full text — paste it wherever you work on it';
    btn.textContent = '⧉ Copy';
    const headerSub = document.getElementById('rs-header-sub');
    if (headerSub) {
      headerSub.appendChild(btn);
    } else if (typeof root.insertBefore === 'function') {
      root.insertBefore(btn, root.firstChild || null);
    } else if (typeof root.appendChild === 'function') {
      root.appendChild(btn);
    }
    return btn;
  }
  function cardFullText(card) {
    const k = card.kind || 'text';
    const out = [];
    if (card.title) out.push(String(card.title));
    if (k === 'script' || k === 'chapter' || k === 'logline') {
      if (card.preview) out.push(String(card.preview));
      const t = typeof card.media === 'string' ? card.media : (card.media && card.media.text) || '';
      // Avoid duplicating when preview and media carry the same logline.
      if (t && String(t).trim() !== String(card.preview || '').trim()) out.push(String(t));
    } else if (card.preview) {
      out.push(String(card.preview));
    }
    return out.join('\n\n').trim();
  }
  function syncChromeCopy(card) {
    copyBtn.hidden = !(card && isTextCard(card));
  }
  function wireChromeCopy(btn) {
    if (!btn || btn.dataset.copyWired) return;
    btn.dataset.copyWired = '1';
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = deck[0];
      if (!card || !isTextCard(card)) return;
      const text = cardFullText(card);
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; }
      catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', '');
          ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch { ok = false; }
      }
      flashCopy(btn, ok);
    });
  }
  function flashCopy(btn, ok) {
    const prev = btn.innerHTML;
    btn.innerHTML = ok ? '✓ Copied' : '⚠ Ctrl+C';
    btn.classList.toggle('rs-card-copy-done', ok);
    setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('rs-card-copy-done'); }, 1500);
  }

  // ── Drag handling ────────────────────────────────────────────────────────
  function attachPointerHandlers(el) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup',   onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
  }

  function onDown(e) {
    if (!topEl) return;
    // Don't hijack drags that start on interactive children (e.g. <video>
    // controls, scrollable script <pre>). The browser still routes the click.
    const t = e.target;
    if (t && (t.closest('video') || t.closest('audio') || t.closest('.rs-card-script') || t.closest('.rs-card-copy'))) return;
    // Zoomed image/video: pan inside the media frame instead of starting a swipe.
    const media = t && t.closest('.rs-card-media');
    if (media && (media.scrollWidth > media.clientWidth + 1 || media.scrollHeight > media.clientHeight + 1)) return;
    dragging  = true;
    startX    = e.clientX;
    dx        = 0;
    pointerId = e.pointerId;
    topEl.classList.add('rs-card-dragging');
    try { topEl.setPointerCapture(pointerId); } catch {}
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    updateTransform(dx);
  }

  function onUp(e) {
    if (!dragging) return;
    if (e && e.pointerId !== pointerId && pointerId !== null) return;
    dragging = false;
    if (topEl) {
      topEl.classList.remove('rs-card-dragging');
      try { topEl.releasePointerCapture(pointerId); } catch {}
    }
    pointerId = null;

    if (dx >  SWIPE_THRESHOLD) commit('keep');
    else if (dx < -SWIPE_THRESHOLD) commit('discard');
    else { dx = 0; updateTransform(0); }
  }

  function updateTransform(x) {
    if (!topEl) return;
    const rot = x * ROTATION_FACTOR;
    topEl.style.transform = `translateX(${x}px) rotate(${rot}deg)`;
    topEl.style.setProperty('--rs-keep-opacity',    Math.max(0, Math.min(1,  x / SWIPE_THRESHOLD)));
    topEl.style.setProperty('--rs-discard-opacity', Math.max(0, Math.min(1, -x / SWIPE_THRESHOLD)));
  }

  // ── Commit a verdict ─────────────────────────────────────────────────────
  function finishCommitSlice() {
    // Only gate the empty/finish path on persist. Mid-deck flips stay snappy.
    if (deck.length === 0) {
      lastVerdictPromise.finally(() => { render(); });
    } else {
      render();
    }
  }

  function commit(decision) {
    if (pendingTimer) {
      // A prior commit's exit is still animating — apply it now so this click
      // decides the NEXT card instead of double-deciding the same one.
      clearTimeout(pendingTimer);
      pendingTimer = null; pendingCardId = null;
      deck = deck.slice(1);
      finishCommitSlice();
    }
    if (deck.length === 0) return;
    const card = deck[0];
    const { note, voiceNote: vn } = readOnly ? { note: '', voiceNote: '' } : takeNote();
    if (topEl) {
      topEl.classList.add('rs-card-exit');
      if (decision === 'revise') {
        // revised cards drop down — filed away, not flung off
        topEl.style.transform = `translateY(620px) rotate(3deg)`;
      } else {
        const dir = decision === 'keep' ? 1 : -1;
        topEl.style.transform = `translateX(${dir * 600}px) rotate(${dir * 18}deg)`;
      }
    }
    history.push({ card, note, voiceNote: vn });
    undoBtn.disabled = false;

    // Persist BEFORE empty/finish render. onEmpty → finish-guard reads the store;
    // if we render empty while putVerdict is still in flight, the guard thinks
    // cards are unswiped and setDeck()'s them back — user feels "stuck".
    let verdictPromise = Promise.resolve();
    if (!readOnly && typeof onVerdict === 'function') {
      try {
        verdictPromise = Promise.resolve(
          onVerdict({ card, decision, note, voiceNote: vn })
        ).catch((err) => console.error('onVerdict handler threw:', err));
      } catch (err) {
        console.error('onVerdict handler threw:', err);
      }
    }
    lastVerdictPromise = verdictPromise;

    pendingCardId = card.id;
    pendingTimer = setTimeout(() => {
      pendingTimer = null; pendingCardId = null;
      deck = deck.slice(1);
      dx = 0;
      finishCommitSlice();
    }, 220);
  }

  // ── Undo the last decision ───────────────────────────────────────────────
  // Puts the last-decided card back on top and tells the controller to erase
  // its verdict. Works any number of steps back within this sitting, including
  // from the "all decided" screen. The note that rode the undone decision comes
  // back in the bar, editable — undo never costs you what you typed.
  function undoLast() {
    if (!history.length) return;
    const undone = history.pop();
    const card = undone.card;
    undoBtn.disabled = history.length === 0;
    if (pendingTimer && pendingCardId === card.id) {
      clearTimeout(pendingTimer);
      pendingTimer = null; pendingCardId = null;
    }
    if (typeof onUndo === 'function') {
      try { onUndo({ card }); }
      catch (err) { console.error('onUndo handler threw:', err); }
    }
    // Undo must never eat text. Anything actually typed in the bar survives the
    // re-render; an empty bar gets back the note that rode the undone decision,
    // so re-deciding keeps (or tweaks) it instead of silently losing it.
    const draft = readOnly ? '' : String(noteInput.value || '');
    const wasAutoFill = draft === prefilled;
    deck = [card, ...deck.filter((c) => c.id !== card.id)];
    dx = 0;
    render();
    if (!readOnly) {
      if (draft.trim() && !wasAutoFill) {
        noteInput.value = draft;
      } else if (undone.note) {
        noteInput.value = undone.note;
        noteStat.textContent = '';
      } else if (undone.voiceNote && !voiceNote) {
        voiceNote = undone.voiceNote;
        noteStat.innerHTML = '🎙 voice note ✓ <button class="rs-note-clear" type="button" aria-label="Clear voice note">×</button>';
        const clr = noteStat.querySelector('.rs-note-clear');
        if (clr) clr.addEventListener('click', clearVoice);
      }
    }
  }

  // ── Public ───────────────────────────────────────────────────────────────
  function setDeck(cards) {
    started = true;
    deck = Array.isArray(cards) ? cards.slice() : [];
    deckTotal = deck.length;
    dx = 0;
    history = [];               // fresh deck = fresh undo trail
    undoBtn.disabled = true;
    render();
  }

  // ── Hover-lift the verdict chrome ─────────────────────────────────────────
  // at big card sizes the note bar and verdict buttons
  // should sit BEHIND the card — the picture is the feature — and surface in
  // FRONT when you reach for them, so they stay clickable.
  //
  // A plain CSS `:hover` cannot do this. Where the card overlaps the chrome the
  // card is the topmost element, so IT takes the hover and the chrome underneath
  // never knows the pointer is there. So we test the pointer against the chrome's
  // own rects instead, which is independent of who's painted on top.
  //
  // Touch devices have no hover: the stylesheet only sends the chrome behind
  // under `(hover: hover) and (pointer: fine)`, so on a phone it stays in front
  // and this listener simply never matters.
  function chromeContains(x, y) {
    const pad = 14; // forgiving edge — you shouldn't have to be precise
    for (const el of [copyBtn, noteEl, noteStat, actionsEl]) {
      if (!el || el.hidden || typeof el.getBoundingClientRect !== 'function') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (x >= r.left - pad && x <= r.right + pad &&
          y >= r.top - pad  && y <= r.bottom + pad) return true;
    }
    return false;
  }
  function onChromePointer(e) {
    root.classList.toggle('rs-chrome-lifted', chromeContains(e.clientX, e.clientY));
  }
  function onChromeLeave() {
    root.classList.remove('rs-chrome-lifted');
  }
  root.addEventListener('pointermove', onChromePointer);
  root.addEventListener('pointerleave', onChromeLeave);

  function destroy() {
    keepBtn.replaceWith(keepBtn.cloneNode(true));
    discBtn.replaceWith(discBtn.cloneNode(true));
    reviseBtn.replaceWith(reviseBtn.cloneNode(true));
    undoBtn.replaceWith(undoBtn.cloneNode(true));
    stackEl.innerHTML = '';
    root.removeEventListener('pointermove', onChromePointer);
    root.removeEventListener('pointerleave', onChromeLeave);
    root.classList.remove('rs-swipe-root', 'rs-chrome-lifted');
    try { if (copyBtn) copyBtn.remove(); } catch { /* test stubs have no remove() */ }
  }

  render();
  return { setDeck, destroy };
}
