// Opaque hosted-media storage seam. Replacing this module is the only change
// needed to move media to R2/S3 later.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';

import { DATA_DIR } from './db.mjs';

const MEDIA_ROOT = join(DATA_DIR, 'media');
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export class StorageLimitError extends Error {
  constructor(limitBytes) {
    super(`media exceeds ${limitBytes} bytes`);
    this.code = 'storage_limit';
    this.limitBytes = limitBytes;
  }
}

function partsFor(key) {
  const parts = String(key || '').split('/');
  if (parts.length !== 3 || parts.some((part) => !SAFE_SEGMENT.test(part) || part === '.' || part === '..')) {
    throw new Error('invalid media key');
  }
  return parts;
}

function pathFor(key) {
  const target = normalize(join(MEDIA_ROOT, ...partsFor(key)));
  const root = normalize(MEDIA_ROOT + sep);
  if (!target.toLowerCase().startsWith(root.toLowerCase())) throw new Error('invalid media key');
  return target;
}

export async function put(stream, key, { maxBytes = Infinity } = {}) {
  const target = pathFor(key);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new StorageLimitError(maxBytes));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, createWriteStream(temp, { flags: 'wx' }));
    await rm(target, { force: true });
    await rename(temp, target);
    return { key, bytes };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function get(key, options = undefined) {
  const target = pathFor(key);
  const info = await stat(target);
  return { key, bytes: info.size, stream: createReadStream(target, options) };
}

export async function del(key) {
  await rm(pathFor(key), { force: true });
}

export async function usage(workspaceId) {
  if (!SAFE_SEGMENT.test(String(workspaceId || ''))) throw new Error('invalid workspace id');
  const root = join(MEDIA_ROOT, workspaceId);
  let total = 0;
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) total += (await stat(child)).size;
    }
  }
  await walk(root);
  return total;
}

/**
 * Delete every stored byte for a workspace.
 *
 * Needed because deleting an account cascades the DATABASE rows but left the files
 * on disk — private media outliving the account, with no row left to discover it
 * through. That is the opposite of what the privacy policy promises. (2026-07-29)
 *
 * Guarded by the same SAFE_SEGMENT check as usage(): an unvalidated id here would
 * be an `rm -rf` with attacker-chosen path segments.
 */
export async function purgeWorkspace(workspaceId) {
  if (!SAFE_SEGMENT.test(String(workspaceId || ''))) throw new Error('invalid workspace id');
  const root = join(MEDIA_ROOT, workspaceId);
  const normalisedRoot = normalize(root);
  const mediaRoot = normalize(MEDIA_ROOT + sep);
  // Belt and braces: never delete outside the media root, whatever the id looked like.
  if (!normalisedRoot.startsWith(mediaRoot)) throw new Error('refusing to delete outside the media root');
  await rm(normalisedRoot, { recursive: true, force: true });
}

export function mediaKey(workspaceId, deckId, cardId) {
  const cardKey = `c-${createHash('sha256').update(String(cardId)).digest('hex')}`;
  const key = `${workspaceId}/${deckId}/${cardKey}`;
  partsFor(key);
  return key;
}
