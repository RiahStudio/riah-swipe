#!/usr/bin/env node
// Copy board/ into hermes-plugin/board/ so the Hermes plugin is self-contained.
// The Hermes catalog installs only the hermes-plugin/ folder, so it carries its
// own copy of the board. Run this after any change under board/:
//   node scripts/sync-hermes-board.mjs
// hermes-plugin/tests/test_board_sync.py fails if the two copies drift.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repo, 'board');
const dest = join(repo, 'hermes-plugin', 'board');
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log('board/ -> hermes-plugin/board/ synced');
