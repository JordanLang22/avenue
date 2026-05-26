import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SETTINGS,
  limitRenderedRows,
  normalizeSettings,
  reconcileSelection,
  selectedIdsForRange,
  virtualizeRows,
} from './state-helpers.js';

describe('settings migration', () => {
  it('defaults new settings to compact rows', () => {
    const settings = normalizeSettings();

    assert.equal(settings.compact, true);
  });

  it('preserves an explicit non-compact preference', () => {
    const settings = normalizeSettings({ compact: false });

    assert.equal(settings.compact, false);
  });

  it('drops removed auto-archive settings during migration', () => {
    const settings = normalizeSettings({ archiveEnabled: true, archiveHours: 24 });

    assert.equal(Object.hasOwn(settings, 'archiveEnabled'), false);
    assert.equal(Object.hasOwn(settings, 'archiveHours'), false);
  });

  it('defaults to system theme and clamps migrated values', () => {
    const settings = normalizeSettings({
      theme: 'sepia',
      accent: 'red',
      indent: 100,
      historyRange: 'not-a-number',
      lastPanel: 'spaces',
      panelQueries: { tabs: 'x'.repeat(300) },
      urlHover: true,
    });

    assert.equal(settings.theme, 'system');
    assert.equal(settings.accent, DEFAULT_SETTINGS.accent);
    assert.equal(settings.indent, 30);
    assert.equal(settings.historyRange, DEFAULT_SETTINGS.historyRange);
    assert.equal(settings.lastPanel, 'tabs');
    assert.equal(settings.panelQueries.tabs.length, 240);
    assert.equal(settings.urlHover, false);
  });
});

describe('selection state', () => {
  const tabs = [
    { id: 10, active: false },
    { id: 11, active: true },
    { id: 12, active: false },
    { id: 13, active: false },
  ];

  it('removes stale selected ids and keeps a valid anchor', () => {
    const state = reconcileSelection({
      tabs,
      highlightedIds: new Set([9, 10, 12]),
      activeId: 9,
      lastSelectionAnchorId: 9,
    });

    assert.deepEqual([...state.highlightedIds], [10, 12]);
    assert.equal(state.activeId, 11);
    assert.equal(state.lastSelectionAnchorId, 11);
  });

  it('selects ranges in either direction', () => {
    assert.deepEqual(selectedIdsForRange([10, 11, 12, 13], 10, 13), [10, 11, 12, 13]);
    assert.deepEqual(selectedIdsForRange([10, 11, 12, 13], 13, 10), [10, 11, 12, 13]);
  });
});

describe('render helpers', () => {
  it('caps very large render batches without changing small sessions', () => {
    assert.deepEqual(limitRenderedRows(['a', 'b'], 3), { rows: ['a', 'b'], omitted: 0 });

    const capped = limitRenderedRows([1, 2, 3, 4], 2);
    assert.deepEqual(capped.rows, [1, 2]);
    assert.equal(capped.omitted, 2);
  });

  it('virtualizes large row sets around the scroll viewport', () => {
    const rows = Array.from({ length: 1000 }, (_, index) => `row-${index}`);
    const result = virtualizeRows(rows, {
      scrollTop: 30 * 400,
      viewportHeight: 300,
      rowHeight: 30,
      overscan: 3,
      threshold: 100,
    });

    assert.equal(result.virtualized, true);
    assert.deepEqual(result.rows.slice(0, 3), ['row-397', 'row-398', 'row-399']);
    assert.equal(result.topSpacer, 397 * 30);
    assert.equal(result.bottomSpacer, (1000 - result.endIndex) * 30);
  });

  it('does not virtualize short row sets', () => {
    const result = virtualizeRows(['a', 'b', 'c'], {
      scrollTop: 999,
      viewportHeight: 30,
      rowHeight: 30,
      threshold: 100,
    });

    assert.deepEqual(result.rows, ['a', 'b', 'c']);
    assert.equal(result.virtualized, false);
    assert.equal(result.topSpacer, 0);
    assert.equal(result.bottomSpacer, 0);
  });
});
