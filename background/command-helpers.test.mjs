import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectBlockTabIds,
  insertionIndexForMove,
  normalizeTabIdList,
} from './command-helpers.js';

describe('tab command helpers', () => {
  const tabs = [
    { id: 1, index: 0, pinned: true, groupId: -1 },
    { id: 2, index: 1, pinned: false, groupId: 7 },
    { id: 3, index: 2, pinned: false, groupId: 7 },
    { id: 4, index: 3, pinned: false, groupId: -1 },
    { id: 5, index: 4, pinned: false, groupId: 8 },
    { id: 6, index: 5, pinned: false, groupId: 8 },
  ];

  it('normalizes tab ids in visual order and filters stale or pinned ids', () => {
    assert.deepEqual(normalizeTabIdList([6, 1, 99, 2, 2], tabs), [2, 6]);
    assert.deepEqual(normalizeTabIdList([6, 1, 2], tabs, { allowPinned: true }), [1, 2, 6]);
  });

  it('collects whole group blocks in visual order', () => {
    assert.deepEqual(collectBlockTabIds(tabs, 'group', 7), [2, 3]);
    assert.deepEqual(collectBlockTabIds(tabs, 'group', 99), []);
  });

  it('computes insertion indexes that account for tabs removed before the target', () => {
    assert.equal(insertionIndexForMove(tabs, [2, 3], [5, 6], 'before'), 2);
    assert.equal(insertionIndexForMove(tabs, [2, 3], [5, 6], 'after'), 4);
    assert.equal(insertionIndexForMove(tabs, [5, 6], [2, 3], 'before'), 1);
    assert.equal(insertionIndexForMove(tabs, [5, 6], [2, 3], 'after'), 3);
  });
});
