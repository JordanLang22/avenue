import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const source = await readFile(sourcePath, 'utf8');

test('favorites section is not unconditionally hidden after loading favorites', () => {
  const renderFavoritesSection = source.match(/function renderFavoritesSection\(\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.doesNotMatch(renderFavoritesSection, /wrap\.classList\.add\('hidden'\);\s*list\.innerHTML = '';/);
  assert.match(renderFavoritesSection, /favoriteRow\(favorite\)/);
  assert.match(renderFavoritesSection, /OPEN_FAVORITE/);
  assert.match(renderFavoritesSection, /favoriteCtxMenu/);
});
