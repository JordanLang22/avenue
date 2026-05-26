export function normalizeTabIdList(rawTabIds = [], tabs = [], { allowPinned = false } = {}) {
  const requested = new Set(rawTabIds.map(Number).filter(Number.isFinite));
  return [...tabs]
    .filter((tab) => requested.has(tab.id))
    .filter((tab) => allowPinned || !tab.pinned)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);
}

export function collectBlockTabIds(tabs = [], kind, blockId) {
  const sortedTabs = [...tabs].sort((a, b) => a.index - b.index);

  if (kind === 'group') {
    return sortedTabs
      .filter((tab) => tab.groupId === blockId)
      .map((tab) => tab.id);
  }

  if (kind === 'folder') {
    const wanted = new Set(Array.isArray(blockId) ? blockId : []);
    return sortedTabs
      .filter((tab) => wanted.has(tab.id))
      .map((tab) => tab.id);
  }

  return [];
}

export function insertionIndexForMove(tabs = [], movingIds = [], targetIds = [], position = 'after') {
  const moving = new Set(movingIds);
  const target = new Set(targetIds);
  const sortedTabs = [...tabs].sort((a, b) => a.index - b.index);
  const targetTabs = sortedTabs.filter((tab) => target.has(tab.id));

  if (!moving.size || !targetTabs.length) return -1;

  const rawIndex = position === 'before'
    ? targetTabs[0].index
    : targetTabs[targetTabs.length - 1].index + 1;
  const removedBeforeTarget = sortedTabs.filter((tab) => moving.has(tab.id) && tab.index < rawIndex).length;

  return Math.max(0, rawIndex - removedBeforeTarget);
}
