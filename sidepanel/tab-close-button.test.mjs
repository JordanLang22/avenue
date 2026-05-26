import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'index.css');
const css = await readFile(cssPath, 'utf8');

test('highlighted selection marker cannot cover tab close buttons', () => {
  assert.match(
    css,
    /\.tab-row\.is-highlighted::after,\s*\.pin-row\.is-highlighted::after\s*\{[^}]*pointer-events:\s*none\s*;/s,
  );
  assert.match(
    css,
    /\.tab-x,\s*\.row-menu\s*\{[^}]*z-index:\s*[1-9]\d*\s*;/s,
  );
});
