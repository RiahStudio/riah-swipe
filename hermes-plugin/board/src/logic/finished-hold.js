// How long a finished deck stays on the machine after the server picks it up.
// the user 2026-08-25: stay in Recently Swiped until filed; THEN hold 7 days.
// Never delete anything that has not been filed. Device send (sentAt) is not pickup.
export const FINISHED_HOLD_DAYS = 7;
export const FINISHED_HOLD_MS = FINISHED_HOLD_DAYS * 24 * 60 * 60 * 1000;

/** Server pickup time. sortedAt = filed at home. sentAt is only the device send. */
export function parseFinishedAt(verdict, fileMtimeMs) {
  const stamp = verdict && verdict.sortedAt;
  const fromStamp = stamp ? Date.parse(stamp) : NaN;
  if (Number.isFinite(fromStamp)) return fromStamp;
  if (Number.isFinite(fileMtimeMs)) return fileMtimeMs;
  return NaN;
}

/** True while the 7-day clock is still running. No date → keep (never drop blind). */
export function stillHolding(finishedAtMs, now = Date.now()) {
  if (!Number.isFinite(finishedAtMs)) return true;
  return now - finishedAtMs < FINISHED_HOLD_MS;
}

/**
 * Pictures / retire / device purge are allowed only when the deck has been filed
 * the deck (routed swipe-verdicts, not _unrouted) AND 7 days have passed.
 */
export function mayDrop({ filed, finishedAtMs, now = Date.now() } = {}) {
  if (!filed) return false;
  return !stillHolding(finishedAtMs, now);
}
