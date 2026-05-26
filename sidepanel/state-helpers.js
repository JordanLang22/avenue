export const DEFAULT_SETTINGS = {
  theme: 'system',
  accent: '#6678f0',
  indent: 14,
  favicons: true,
  compact: true,
  urlHover: false,
  userEnabledUrlHover: false,
  treeLines: true,
  groups: true,
  tabMeta: true,
  customCss: '',
  lastPanel: 'tabs',
  panelQueries: {
    tabs: '',
    bookmarks: '',
    history: '',
  },
  historyRange: 86400000,
  pinnedCollapsed: false,
};

export const PANEL_IDS = new Set(['tabs', 'bookmarks', 'history']);
export const MAX_RENDER_ROWS = 700;
export const VIRTUAL_RENDER_THRESHOLD = 260;
export const DEFAULT_VIRTUAL_ROW_HEIGHT = 34;
export const DEFAULT_VIRTUAL_OVERSCAN = 8;

export function clampNumber(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

export function normalizePanelQueries(rawQueries = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS.panelQueries).map(([key, fallback]) => [
      key,
      String(rawQueries?.[key] ?? fallback).slice(0, 240),
    ]),
  );
}

export function normalizeSettings(rawSettings = {}) {
  const next = { ...DEFAULT_SETTINGS, ...(rawSettings || {}) };
  next.theme = ['system', 'light', 'dark'].includes(next.theme) ? next.theme : DEFAULT_SETTINGS.theme;
  next.accent = /^#[0-9a-f]{6}$/i.test(String(next.accent || '')) ? next.accent : DEFAULT_SETTINGS.accent;
  next.indent = clampNumber(next.indent, DEFAULT_SETTINGS.indent, 10, 30);
  next.historyRange = clampNumber(next.historyRange, DEFAULT_SETTINGS.historyRange, 0, 2592000000);
  next.lastPanel = PANEL_IDS.has(next.lastPanel) ? next.lastPanel : DEFAULT_SETTINGS.lastPanel;
  next.panelQueries = normalizePanelQueries(next.panelQueries);
  next.customCss = String(next.customCss || '').slice(0, 20000);
  next.favicons = !!next.favicons;
  next.compact = !!next.compact;
  next.treeLines = !!next.treeLines;
  next.groups = !!next.groups;
  next.tabMeta = !!next.tabMeta;
  next.pinnedCollapsed = !!next.pinnedCollapsed;
  next.urlHover = false;
  next.userEnabledUrlHover = false;
  delete next.archiveEnabled;
  delete next.archiveHours;
  return next;
}

export function reconcileSelection({
  tabs = [],
  highlightedIds = new Set(),
  activeId = null,
  lastSelectionAnchorId = null,
} = {}) {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const nextHighlightedIds = new Set([...highlightedIds].filter((tabId) => tabIds.has(tabId)));
  const nextActiveId = tabIds.has(activeId) ? activeId : tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null;
  let nextAnchorId = lastSelectionAnchorId;

  if (!nextHighlightedIds.size && nextActiveId != null) nextHighlightedIds.add(nextActiveId);
  if (nextAnchorId != null && !nextHighlightedIds.has(nextAnchorId)) {
    nextAnchorId = nextActiveId;
  }

  return {
    activeId: nextActiveId,
    highlightedIds: nextHighlightedIds,
    lastSelectionAnchorId: nextAnchorId,
  };
}

export function selectedIdsForRange(visibleIds = [], anchorId, targetId) {
  const anchorIndex = visibleIds.indexOf(anchorId);
  const targetIndex = visibleIds.indexOf(targetId);
  if (anchorIndex === -1 || targetIndex === -1) return [targetId].filter((id) => id != null);

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visibleIds.slice(start, end + 1);
}

export function limitRenderedRows(rows = [], maxRows = MAX_RENDER_ROWS) {
  if (rows.length <= maxRows) {
    return { rows, omitted: 0 };
  }

  return {
    rows: rows.slice(0, maxRows),
    omitted: rows.length - maxRows,
  };
}

export function virtualizeRows(rows = [], options = {}) {
  const {
    scrollTop = 0,
    viewportHeight = 0,
    rowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT,
    overscan = DEFAULT_VIRTUAL_OVERSCAN,
    threshold = VIRTUAL_RENDER_THRESHOLD,
  } = options;

  const safeRows = Array.isArray(rows) ? rows : [];
  const safeRowHeight = clampNumber(rowHeight, DEFAULT_VIRTUAL_ROW_HEIGHT, 1, 200);
  const safeViewportHeight = clampNumber(viewportHeight, 0, 0, 100000);
  const safeScrollTop = clampNumber(scrollTop, 0, 0, Number.MAX_SAFE_INTEGER);
  const safeOverscan = Math.floor(clampNumber(overscan, DEFAULT_VIRTUAL_OVERSCAN, 0, 100));

  if (safeRows.length <= threshold || safeViewportHeight <= 0) {
    return {
      rows: safeRows,
      startIndex: 0,
      endIndex: safeRows.length,
      topSpacer: 0,
      bottomSpacer: 0,
      virtualized: false,
    };
  }

  const firstVisibleIndex = Math.floor(safeScrollTop / safeRowHeight);
  const visibleCount = Math.ceil(safeViewportHeight / safeRowHeight);
  const startIndex = Math.max(0, firstVisibleIndex - safeOverscan);
  const endIndex = Math.min(safeRows.length, firstVisibleIndex + visibleCount + safeOverscan);

  return {
    rows: safeRows.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    topSpacer: startIndex * safeRowHeight,
    bottomSpacer: Math.max(0, safeRows.length - endIndex) * safeRowHeight,
    virtualized: true,
  };
}
