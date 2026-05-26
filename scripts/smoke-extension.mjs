import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const extensionPath = process.env.AVENUE_EXTENSION_DIR || root;
const profilePath = await mkdtemp(resolve(tmpdir(), 'avenue-smoke-'));
const consoleMessages = [];

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, message, ...details }, null, 2));
  process.exitCode = 1;
}

const context = await chromium.launchPersistentContext(profilePath, {
  headless: false,
  viewport: { width: 390, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

try {
  const seedPages = await Promise.all([
    context.newPage(),
    context.newPage(),
  ]);
  await Promise.allSettled([
    seedPages[0].goto('https://example.com/?avenue-smoke=one', { waitUntil: 'domcontentloaded', timeout: 8000 }),
    seedPages[1].goto('https://example.org/?avenue-smoke=two', { waitUntil: 'domcontentloaded', timeout: 8000 }),
  ]);

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`));

  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tabs-list', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(500);

  const initial = await page.evaluate(() => ({
    compact: document.body.classList.contains('compact'),
    tabRows: document.querySelectorAll('.tab-row, .pin-row').length,
    settingsHidden: document.querySelector('#settings-panel')?.classList.contains('hidden'),
  }));

  await page.locator('#btn-settings').click();
  await page.waitForTimeout(220);
  await page.locator('#btn-settings-close').click();
  await page.waitForTimeout(260);

  const settingsState = await page.evaluate(() => {
    const panel = document.querySelector('#settings-panel');
    return {
      hidden: panel.classList.contains('hidden'),
      ariaHidden: panel.getAttribute('aria-hidden'),
      inert: panel.inert,
      focusInside: panel.contains(document.activeElement),
      activeElementId: document.activeElement?.id || '',
    };
  });

  const search = page.locator('#search-input');
  await search.fill('example');
  await search.press('Escape');
  const searchValueAfterEscape = await search.inputValue();

  const firstRow = page.locator('.tab-row, .pin-row').first();
  const rowCount = await firstRow.count();
  if (rowCount) {
    await firstRow.click({ button: 'right' });
    await page.waitForTimeout(120);
  }
  const contextMenuVisible = rowCount
    ? await page.locator('#ctx-menu').evaluate((node) => !node.classList.contains('hidden'))
    : false;

  const blockedAriaMessages = consoleMessages.filter((message) => message.includes('Blocked aria-hidden'));
  const errors = consoleMessages.filter((message) => message.startsWith('error:') || message.startsWith('pageerror:'));
  const result = {
    ok: true,
    extensionId,
    initial,
    settingsState,
    searchValueAfterEscape,
    contextMenuVisible,
    blockedAriaMessages,
    errors,
  };

  if (!initial.compact) fail('Compact mode was not active by default.', result);
  if (!initial.settingsHidden) fail('Settings panel was not hidden initially.', result);
  if (!settingsState.hidden || settingsState.ariaHidden !== 'true' || !settingsState.inert || settingsState.focusInside) {
    fail('Settings panel did not close accessibly.', result);
  }
  if (searchValueAfterEscape !== '') fail('Escape did not clear the search field.', result);
  if (rowCount && !contextMenuVisible) fail('Context menu did not open for the first visible tab row.', result);
  if (blockedAriaMessages.length || errors.length) fail('Console errors were emitted during smoke test.', result);

  if (!process.exitCode) console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
}
