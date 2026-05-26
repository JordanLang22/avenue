import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('smoke test resolves extension path with Windows-safe fileURLToPath', async () => {
  const source = await readFile(new URL('./smoke-extension.mjs', import.meta.url), 'utf8');

  assert.match(source, /fileURLToPath/);
  assert.doesNotMatch(source, /new URL\('..', import\.meta\.url\)\.pathname/);
});
