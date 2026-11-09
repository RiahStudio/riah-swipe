// src/logic/approved-thumb.js
// The approved-thumbnail archive, client half:
// every image the user KEEPS gets an extremely small thumbnail captured at
// verdict time, stored on the verdict, and shipped out with the deck's
// results — a compact record of "what approved looks like" that agents can
// compare new generations against.
//
// Tiny on purpose: ~256px longest side, webp (jpeg fallback). Thousands of
// these cost almost nothing, and likeness/style read fine at this size.
//
// Never blocks or breaks a swipe: any failure (offline image, tainted canvas,
// unsupported kind) resolves to '' and the verdict persists without a thumb.

const MAX_SIDE = 256;
const QUALITY  = 0.8;

// Card → data-URI string ('' when no thumbnail can be made).
// Image cards use their media URL; video cards use their poster if present.
export async function captureApprovedThumb(card) {
  try {
    if (!card) return '';
    const src =
      typeof card.media === 'string'
        ? card.media
        : (card.media && card.media.poster) || '';
    if (!src) return '';

    const img = new Image();
    img.decoding = 'async';
    // Same-origin deck assets and data URIs dominate; ask politely for the rest.
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('thumb: image failed to load'));
      img.src = src;
    });

    const w0 = img.naturalWidth  || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return '';
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    // webp preferred; browsers that can't encode it return a png data-URI from
    // toDataURL('image/webp'), so detect and fall back to jpeg for size.
    let out = canvas.toDataURL('image/webp', QUALITY);
    if (!out.startsWith('data:image/webp')) {
      out = canvas.toDataURL('image/jpeg', QUALITY);
    }
    return out;
  } catch {
    return ''; // a missing thumb must never cost the user a swipe
  }
}
