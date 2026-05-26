import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('package script creates zip archives without requiring a system zip binary', async () => {
  const source = await readFile(new URL('./package-extension.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /execFileSync\(\s*['"]zip['"]/);
  assert.match(source, /archiver/);
});
