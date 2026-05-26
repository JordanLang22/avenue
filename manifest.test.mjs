import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('extension requests storage capacity for large sessions', async () => {
  const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));

  assert.equal(manifest.permissions.includes('unlimitedStorage'), true);
});
