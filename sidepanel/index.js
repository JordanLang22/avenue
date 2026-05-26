import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  selectedIdsForRange,
  reconcileSelection,
  virtualizeRows,
} from './state-helpers.js';
import {
  domainOf,
  esc,
  faviconUrl,
  fmtDate,
  fmtTime,
  hl,
} from './dom-utils.js';
import {
  icoAudio,
  icoBookmark,
  icoBranch,
  icoChevron,
  icoCopy,
  icoDiscard,
  icoDup,
  icoEdit,
  icoFolder,
  icoFolderPlus,
  icoGroup,
  icoLayers,
  icoMuted,
  icoOpen,
  icoPin,
  icoPlus,
  icoReload,
  icoReset,
  icoUngroup,
  icoWin,
  icoX,
} from './icons.js';
import {
  clearDropHints,
  createAutoScroller,
  createDelayedFolderExpander,
  dropModeForEvent,
  setDropHint,
} from './drag-helpers.js';
import { createSettingsPanelController } from './settings-panel.js';

const SETTINGS_KEY = 'sb_cfg_v3';
const LEGACY_SETTINGS_KEY = 'sb_cfg_v2';

const GROUP_COLORS = {
  grey: '#94a3b8',
  blue: '#60a5fa',
  red: '#fb7185',
  yellow: '#fbbf24',
  green: '#4ade80',
  pink: '#f472b6',
  purple: '#c084fc',
  cyan: '#22d3ee',
  orange: '#fb923c',
};

let tabs = [];
let tabsById = new Map();
let tree = {};
let groups = {};
let folders = {};
let recentlyClosed = [];
let archivedTabs = [];
let winId = null;
let activeId = null;
let panel = 'tabs';
let query = '';
let bmPath = [];
let bmCache = null;
let historyCache = [];
let highlightedIds = new Set();
let settings = { ...DEFAULT_SETTINGS };
let visibleTabSequence = [];
let lastSelectionAnchorId = null;
let savedSnapshots = [];
let favorites = [];
let smartFolders = [];
let undoState = { canUndo: false, label: '' };
let focusedKey = '';
let editingTabId = null;
let editingFolderId = null;
let editingGroupId = null;
let editingSnapshotId = null;
let editingSmartFolderId = null;
let folderDragId = null;
let groupDragId = null;
let panelQueries = { ...DEFAULT_SETTINGS.panelQueries };
let toastTimer = null;
let renderFrame = 0;
let folderPreviewId = '';
let smartFolderPreviewId = '';

let urlBarEl = null;
let customStyleEl = null;
let settingsSaveTimer = null;
let dragTabId = null;
let dragTabIds = [];

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const autoScroller = createAutoScroller();
const folderExpander = createDelayedFolderExpander({
  getFolder,
  expand: (folderId) => send({ type: 'SET_FOLDER_COLLAPSED', windowId: winId, folderId, collapsed: false }),
});
const settingsPanel = createSettingsPanelController({
  getPanel: () => $('settings-panel'),
  getReturnFocus: () => $('btn-settings'),
});

function currentQuery() {
  return panelQueries[panel] || '';
}

function setCurrentQuery(nextQuery) {
  query = String(nextQuery || '').trim();
  panelQueries[panel] = query;
  if ($('search-input')) $('search-input').value = query;
  if ($('search-clear')) $('search-clear').classList.toggle('show', !!query);
}

function favicon(url) {
  return faviconUrl(url, chrome.runtime.id);
}

function getTab(tabId) {
  return tabsById.get(Number(tabId));
}

function getNode(tabId) {
  return tree[tabId];
}

function getFolder(folderId) {
  return folders[folderId];
}

function tabInCurrentView(tab) {
  return !!tab;
}

function smartFoldersInCurrentView() {
  return smartFolders;
}

function tabIndex(tabId) {
  return getTab(tabId)?.index ?? Number.MAX_SAFE_INTEGER;
}

function displayTitle(tab) {
  const alias = getNode(tab.id)?.customTitle?.trim();
  return alias || tab.title || tab.url || 'New Tab';
}

function hasAlias(tabId) {
  return !!getNode(tabId)?.customTitle?.trim();
}

function focusKeyFor(kind, id) {
  return `${kind}:${id}`;
}

function tabSubtreeIds(tabId) {
  const seen = new Set();
  const out = [];

  const visit = (nextId) => {
    if (seen.has(nextId)) return;
    seen.add(nextId);
    out.push(nextId);
    (getNode(nextId)?.children || []).forEach(visit);
  };

  visit(tabId);
  return out;
}

function clearEditingState() {
  editingTabId = null;
  editingFolderId = null;
  editingGroupId = null;
  editingSnapshotId = null;
  editingSmartFolderId = null;
}

function parseSearch(rawQuery) {
  const tokens = String(rawQuery || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const parsed = {
    raw: rawQuery,
    text: [],
    group: [],
    folder: [],
    is: new Set(),
  };

  tokens.forEach((token) => {
    const lower = token.toLowerCase();
    if (lower.startsWith('group:')) {
      const value = lower.slice(6).trim();
      if (value) parsed.group.push(value);
      return;
    }

    if (lower.startsWith('folder:')) {
      const value = lower.slice(7).trim();
      if (value) parsed.folder.push(value);
      return;
    }

    if (lower.startsWith('is:')) {
      const values = lower.slice(3).split(',').map((value) => value.trim()).filter(Boolean);
      values.forEach((value) => parsed.is.add(value));
      return;
    }

    parsed.text.push(lower);
  });

  return parsed;
}

function fuzzyIncludes(needle, haystack) {
  const source = String(haystack || '').toLowerCase();
  const target = String(needle || '').toLowerCase();
  if (!target) return true;
  if (source.includes(target)) return true;

  let cursor = 0;
  for (const char of source) {
    if (char === target[cursor]) cursor += 1;
    if (cursor >= target.length) return true;
  }

  return false;
}

function depth(tabId) {
  let current = getNode(tabId);
  let value = 0;

  while (current?.parentId != null) {
    value += 1;
    current = getNode(current.parentId);
  }

  return value;
}

function hasCollapsedAncestor(tabId) {
  let current = getNode(tabId);

  while (current?.parentId != null) {
    const parent = getNode(current.parentId);
    if (parent?.collapsed) return true;
    current = parent;
  }

  return false;
}

function treeOrder() {
  const orderedTabs = [...tabs].sort((a, b) => a.index - b.index);
  const roots = orderedTabs
    .filter((tab) => getNode(tab.id)?.parentId == null)
    .map((tab) => tab.id);

  const out = [];
  const visit = (tabId) => {
    out.push(tabId);
    const children = [...(getNode(tabId)?.children || [])].sort((a, b) => tabIndex(a) - tabIndex(b));
    children.forEach(visit);
  };

  roots.forEach(visit);
  orderedTabs.forEach((tab) => {
    if (!out.includes(tab.id)) out.push(tab.id);
  });

  return out;
}

function groupColor(groupColorName) {
  return GROUP_COLORS[groupColorName] || settings.accent;
}

function folderOrderMap(orderedTabs) {
  const map = new Map();
  orderedTabs.forEach((tab) => {
    const folderId = getNode(tab.id)?.folderId;
    if (!folderId) return;
    if (!map.has(folderId)) map.set(folderId, []);
    map.get(folderId).push(tab.id);
  });
  return map;
}

function tabMatchesQuery(tab, parsed) {
  const groupTitle = tab.groupId != null && tab.groupId !== -1 ? groups[tab.groupId]?.title || '' : '';
  const folderTitle = getNode(tab.id)?.folderId ? folders[getNode(tab.id).folderId]?.title || '' : '';
  const haystacks = [displayTitle(tab), tab.title, tab.url, domainOf(tab.url), groupTitle, folderTitle];

  const matchesText = parsed.text.every((term) => haystacks.some((value) => fuzzyIncludes(term, value)));
  if (!matchesText) return false;

  const matchesGroup = parsed.group.every((term) => fuzzyIncludes(term, groupTitle));
  if (!matchesGroup) return false;

  const matchesFolder = parsed.folder.every((term) => fuzzyIncludes(term, folderTitle));
  if (!matchesFolder) return false;

  if (parsed.is.has('pinned') && !tab.pinned) return false;
  if (parsed.is.has('audible') && !tab.audible) return false;
  if (parsed.is.has('muted') && !tab.mutedInfo?.muted) return false;
  if (parsed.is.has('discarded') && !tab.discarded) return false;
  if (parsed.is.has('grouped') && (tab.groupId == null || tab.groupId === -1)) return false;
  if (parsed.is.has('foldered') && !folderTitle) return false;

  return parsed.text.length > 0 || parsed.group.length > 0 || parsed.folder.length > 0 || parsed.is.size > 0;
}

function matchedTabIds() {
  if (!query) return null;

  const parsed = parseSearch(query);
  const matches = new Set();

  const addWithAncestors = (tabId) => {
    let currentId = tabId;
    while (currentId != null) {
      matches.add(currentId);
      currentId = getNode(currentId)?.parentId ?? null;
    }
  };

  tabs.forEach((tab) => {
    if (!tabInCurrentView(tab)) return;
    if (tabMatchesQuery(tab, parsed)) addWithAncestors(tab.id);
  });

  return matches;
}

function folderQueryState(orderedTabs, matchedSet) {
  const byFolder = folderOrderMap(orderedTabs);
  const state = new Map();
  const parsed = parseSearch(query);

  Object.values(folders).forEach((folder) => {
    const tabIds = byFolder.get(folder.id) || [];
    const titleHit = parsed.text.some((term) => fuzzyIncludes(term, folder.title || ''))
      || parsed.folder.some((term) => fuzzyIncludes(term, folder.title || ''));
    const matchIds = new Set(tabIds.filter((tabId) => matchedSet?.has(tabId)));
    const show = !query ? true : titleHit || matchIds.size > 0;
    const expand = !query ? !folder.collapsed : titleHit || matchIds.size > 0;
    state.set(folder.id, { tabIds, titleHit, matchIds, show, expand });
  });

  return state;
}

function visibleStandaloneTab(tab, matches) {
  if (matches) return matches.has(tab.id);
  if (tab.groupId != null && tab.groupId !== -1 && settings.groups && groups[tab.groupId]?.collapsed) return false;
  return !hasCollapsedAncestor(tab.id);
}

function rootCount() {
  return tabs.filter((tab) => tabInCurrentView(tab) && !tab.pinned && getNode(tab.id)?.parentId == null && !getNode(tab.id)?.folderId).length;
}

function folderCount() {
  const currentViewFolderIds = new Set(
    tabs
      .filter((tab) => tabInCurrentView(tab))
      .map((tab) => getNode(tab.id)?.folderId)
      .filter(Boolean),
  );
  return currentViewFolderIds.size + smartFoldersInCurrentView().length;
}

function hasNestedTabs() {
  return tabs.some((tab) => tabInCurrentView(tab) && !tab.pinned && getNode(tab.id)?.parentId != null);
}

function matchingTabCount(rawQuery = '') {
  const normalizedQuery = String(rawQuery || '').trim();
  if (!normalizedQuery) return 0;

  const parsed = parseSearch(normalizedQuery);
  let count = 0;
  tabs.forEach((tab) => {
    if (!tabInCurrentView(tab)) return;
    if (tabMatchesQuery(tab, parsed)) count += 1;
  });
  return count;
}

function renderSummary() {
  const summary = $('tabs-summary');
  const tabsQuery = panel === 'tabs' ? query : (panelQueries.tabs || '');
  const contextPills = [];
  const selectedCount = currentSelectedTabIds().length;
  const currentFolderCount = folderCount();

  if (tabsQuery) {
    const matchCount = matchingTabCount(tabsQuery);
    contextPills.push(`<span class="summary-pill">${matchCount} match${matchCount === 1 ? '' : 'es'}</span>`);
  }

  if (selectedCount > 1) {
    contextPills.push(`<span class="summary-pill">${selectedCount} selected</span>`);
  }

  if (currentFolderCount) {
    contextPills.push(`<span class="summary-pill">${currentFolderCount} folder${currentFolderCount === 1 ? '' : 's'}</span>`);
  }

  if (hasNestedTabs()) {
    contextPills.push(`<span class="summary-pill">${rootCount()} roots</span>`);
  }

  if (!contextPills.length) {
    summary.innerHTML = '';
    summary.classList.add('hidden');
    return;
  }

  summary.classList.remove('hidden');
  const scopedTabCount = tabs.filter((tab) => tabInCurrentView(tab)).length;
  summary.innerHTML = [`<span class="summary-pill">${scopedTabCount} tabs</span>`, ...contextPills].join('');
}

function updateNavCounts() {
  const scopedTabs = tabs.filter((tab) => tabInCurrentView(tab));
  $('count-tabs').textContent = String(scopedTabs.length || '');
  $('count-bookmarks').textContent = bmCache?.[0]?.children?.length ? String(bmCache[0].children.length) : '';
  $('count-history').textContent = archivedTabs.length
    ? String(archivedTabs.length)
    : savedSnapshots.length
      ? String(savedSnapshots.length)
      : recentlyClosed.length
        ? String(recentlyClosed.length)
        : '';
  $('bookmarks-meta').textContent = bmPath.length
    ? `${currentBmFolder()?.children?.length || 0} items in ${currentBmFolder()?.title || 'folder'}`
    : `${bmCache?.[0]?.children?.length || 0} root items`;
  $('history-meta').textContent = [
    savedSnapshots.length ? `${savedSnapshots.length} snapshots` : '',
    archivedTabs.length ? `${archivedTabs.length} archived` : '',
    recentlyClosed.length ? `${recentlyClosed.length} recently closed` : '',
    historyCache.length ? `${historyCache.length} history items` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function currentSelectedTabIds() {
  return tabs
    .filter((tab) => highlightedIds.has(tab.id) && tabInCurrentView(tab))
    .map((tab) => tab.id)
    .sort((a, b) => tabIndex(a) - tabIndex(b));
}

function reconcileSelectionState() {
  const state = reconcileSelection({
    tabs,
    highlightedIds,
    activeId,
    lastSelectionAnchorId,
  });
  highlightedIds = state.highlightedIds;
  activeId = state.activeId;
  lastSelectionAnchorId = state.lastSelectionAnchorId;
}

function updateSelectionBar() {
  reconcileSelectionState();
  const selectedIds = currentSelectedTabIds();
  const selectedTabs = selectedIds.map(getTab).filter(Boolean);
  const bar = $('selection-bar');
  const panelTabs = $('panel-tabs');
  const hasSelection = selectedTabs.length >= 2;

  bar.classList.toggle('is-visible', hasSelection);
  bar.setAttribute('aria-hidden', hasSelection ? 'false' : 'true');
  panelTabs?.classList.toggle('has-selection-bar', hasSelection);
  if (!hasSelection) return;

  const folderedCount = selectedTabs.filter((tab) => !!getNode(tab.id)?.folderId).length;
  const pinnedCount = selectedTabs.filter((tab) => tab.pinned).length;
  const mutedCount = selectedTabs.filter((tab) => tab.mutedInfo?.muted).length;
  $('selection-title').textContent = `${selectedTabs.length} selected`;
  $('selection-meta').textContent = [
    folderedCount ? `${folderedCount} foldered` : '',
    pinnedCount ? `${pinnedCount} pinned` : '',
    mutedCount ? `${mutedCount} muted` : '',
  ]
    .filter(Boolean)
    .join(' · ') || 'Bulk actions';

  $('btn-selection-unfolder').disabled = folderedCount === 0;
  $('btn-selection-folder').disabled = selectedTabs.every((tab) => tab.pinned);
  $('btn-selection-group').disabled = selectedTabs.every((tab) => tab.pinned);
  $('btn-selection-ungroup').disabled = selectedTabs.every((tab) => tab.groupId == null || tab.groupId === -1);
  $('btn-selection-pin').textContent = selectedTabs.every((tab) => tab.pinned) ? 'Unpin' : 'Pin';
  $('btn-selection-mute').textContent = selectedTabs.every((tab) => tab.mutedInfo?.muted) ? 'Unmute' : 'Mute';
}

function showToast(message) {
  const toast = $('toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('show'));
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 180);
  }, 2400);
}

async function loadFavorites() {
  const result = await send({ type: 'GET_FAVORITES' });
  favorites = result.favorites || [];
  renderFavoritesSection();
}

async function loadSmartFolders() {
  const result = await send({ type: 'GET_SMART_FOLDERS' });
  smartFolders = result.smartFolders || [];
  if (panel === 'tabs') renderTabs();
}

async function loadArchivedTabs() {
  const result = await send({ type: 'GET_ARCHIVED_TABS' });
  archivedTabs = result.archivedTabs || [];
  renderArchivedTabs();
  updateNavCounts();
}

async function loadUndoState() {
  if (winId == null) return;
  undoState = await send({ type: 'GET_UNDO_STATUS', windowId: winId });
  renderQuickActions();
}

function favoriteRow(favorite) {
  return `
    <div class="favorite-row" data-favorite-id="${favorite.id}" role="button" aria-label="Favorite ${esc(favorite.title || 'Favorite')}">
      ${itemIconMarkup(favorite.url, (favorite.icon || favorite.title || 'F').slice(0, 1).toUpperCase(), 'favorite-fav')}
      <div class="favorite-copy">
        <span class="favorite-title">${esc(favorite.title || hostForFavorite(favorite.url) || 'Favorite')}</span>
        <span class="favorite-meta">${esc(hostForFavorite(favorite.url))}</span>
      </div>
      <button class="row-menu" data-favorite-menu="${favorite.id}" title="Favorite actions">⋯</button>
    </div>
  `;
}

function hostForFavorite(url) {
  return domainOf(url || '').replace(/^www\./, '');
}

function renderFavoritesSection() {
  const wrap = $('favorites-wrap');
  const list = $('favorites-list');
  if (!wrap || !list) return;

  wrap.classList.toggle('hidden', !favorites.length);
  if (!favorites.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = favorites.map((favorite) => favoriteRow(favorite)).join('');

  list.querySelectorAll('.favorite-row').forEach((row) => {
    const favoriteId = row.dataset.favoriteId;
    row.onclick = (event) => {
      if (event.target.closest('[data-favorite-menu]')) return;
      send({ type: 'OPEN_FAVORITE', windowId: winId, favoriteId });
    };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      favoriteCtxMenu(event, favoriteId);
    };
  });

  list.querySelectorAll('[data-favorite-menu]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      favoriteCtxMenu(event, button.dataset.favoriteMenu);
    };
  });
}

function smartFolderMembers(folder) {
  const parsed = parseSearch(folder.query || '');
  return [...tabs]
    .filter((tab) => !tab.pinned && tabInCurrentView(tab) && tabMatchesQuery(tab, parsed))
    .sort((a, b) => a.index - b.index);
}

function smartFolderRow(folder, count) {
  const isEditing = editingSmartFolderId === folder.id;
  const expanded = !folder.collapsed;
  const focusKey = focusKeyFor('smart-folder', folder.id);
  return `
    <div class="folder-row smart-folder-row ${expanded ? '' : 'is-collapsed'} ${isFocusedItem('smart-folder', folder.id) ? 'is-focused' : ''}" data-smart-folder-id="${folder.id}" data-focus-key="${focusKey}" role="treeitem" aria-expanded="${String(expanded)}" tabindex="${isFocusedItem('smart-folder', folder.id) ? '0' : '-1'}">
      <button class="folder-exp ${expanded ? '' : 'is-collapsed'}" data-smart-folder-toggle="${folder.id}">
        <svg viewBox="0 0 9 9"><polyline points="1.5,2.5 4.5,6 7.5,2.5"/></svg>
      </button>
      <span class="folder-icon">✦</span>
      <div class="folder-copy">
        ${isEditing ? `<input class="inline-edit" data-inline-edit="smart-folder" data-edit-id="${folder.id}" value="${esc(folder.title || 'Live folder')}" aria-label="Rename live folder">` : `<span class="folder-title">${hl(folder.title || 'Live folder', query)}</span>`}
        <span class="folder-meta">${count} match${count === 1 ? '' : 'es'} · ${esc(folder.query || '')}</span>
      </div>
      <span class="mini-count">${count}</span>
      ${isEditing ? '' : `<button class="row-menu" data-smart-folder-menu="${folder.id}" title="Live folder actions">⋯</button>`}
    </div>
  `;
}

function folderPreviewMarkup(folderId, previewTabs, kind = 'folder') {
  if (!previewTabs.length) return '';
  const rows = previewTabs
    .slice(0, 5)
    .map((tab) => `
      <button class="folder-preview-item" data-preview-tab-id="${tab.id}" data-preview-kind="${kind}">
        ${favMarkup(tab, displayTitle(tab).slice(0, 1).toUpperCase())}
        <span>${hl(displayTitle(tab), query)}</span>
      </button>
    `)
    .join('');
  return `<div class="folder-preview" data-preview-owner="${folderId}" data-preview-kind="${kind}">${rows}</div>`;
}

function renderArchivedTabs() {
  const list = $('archived-list');
  const count = $('archived-count');
  if (!list || !count) return;

  const items = archivedTabs;
  count.textContent = items.length ? String(items.length) : '';
  list.innerHTML = items.length
    ? items
        .map((entry) => `
          <div class="closed-row ${isFocusedItem('archived', entry.id) ? 'is-focused' : ''}" data-archive-id="${entry.id}" data-focus-key="${focusKeyFor('archived', entry.id)}" role="button" tabindex="${isFocusedItem('archived', entry.id) ? '0' : '-1'}">
            ${itemIconMarkup(entry.url, 'A', 'closed-fav')}
            <div class="item-copy">
              <span class="item-title">${esc(entry.customTitle || entry.title || 'Archived tab')}</span>
              <span class="item-meta">${esc(hostForFavorite(entry.url))} · ${fmtDate(entry.archivedAt)} ${fmtTime(entry.archivedAt)}</span>
            </div>
            <button class="row-menu" data-archive-menu="${entry.id}" title="Archive actions">⋯</button>
          </div>
        `)
        .join('')
    : `<div class="empty compact-empty"><span>No archived tabs yet</span></div>`;

  list.querySelectorAll('.closed-row').forEach((row) => {
    const archiveId = row.dataset.archiveId;
    const focusKey = row.dataset.focusKey;
    row.addEventListener('focus', () => setFocusedKey(focusKey));
    row.onclick = async (event) => {
      if (event.target.closest('[data-archive-menu]')) return;
      setFocusedKey(focusKey);
      const result = await send({ type: 'RESTORE_ARCHIVED_TAB', archiveId, windowId: winId });
      if (result?.snapshot) applySnapshot(result.snapshot);
      await loadArchivedTabs();
    };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      archivedCtxMenu(event, archiveId);
    };
  });

  list.querySelectorAll('[data-archive-menu]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      archivedCtxMenu(event, button.dataset.archiveMenu);
    };
  });
}

function renderQuickActions() {
  const wrap = $('quick-actions-wrap');
  if (!wrap) return;

  const showSmartFolderAction = panel === 'tabs' && !!query.trim();
  const showUndoAction = !!undoState?.canUndo;

  wrap.classList.toggle('hidden', !(showSmartFolderAction || showUndoAction));
  $('btn-save-smart-folder').classList.toggle('hidden', !showSmartFolderAction);
  $('btn-undo').disabled = !showUndoAction;
  $('btn-undo').textContent = showUndoAction && undoState.label ? `Undo ${undoState.label}` : 'Undo';
  $('btn-undo').classList.toggle('hidden', !showUndoAction);
}

function favMarkup(tab, fallback) {
  if (tab.status === 'loading') return '<div class="tab-spin"></div>';
  if (!settings.favicons) return `<div class="tab-fav-ph">${esc(fallback)}</div>`;

  const src = favicon(tab.url);
  return src
    ? `<img class="tab-fav" src="${src}" alt="" loading="lazy">`
    : `<div class="tab-fav-ph">${esc(fallback)}</div>`;
}

function itemIconMarkup(url, fallback = '•', className = 'bm-icon') {
  const src = favicon(url);
  return src
    ? `<img class="${className}" src="${src}" alt="" loading="lazy">`
    : `<div class="item-icon-ph">${esc(fallback)}</div>`;
}

function indentMarkup(depthValue) {
  return `<div class="tab-indent" style="--depth:${depthValue}">${Array.from({ length: depthValue }, () => '<span class="indent-guide"></span>').join('')}</div>`;
}

function tabBadges(tab) {
  const badges = [];

  if (tab.audible && !tab.mutedInfo?.muted) {
    badges.push(`<span class="badge" title="Playing audio">${icoAudio()}</span>`);
  }

  if (tab.mutedInfo?.muted) {
    badges.push(`<span class="badge" title="Muted">${icoMuted()}</span>`);
  }

  if (hasAlias(tab.id)) {
    badges.push('<span class="tag">alias</span>');
  }

  if (tab.pinned) {
    badges.push('<span class="tag">pinned</span>');
  }

  return badges.join('');
}

function tabMeta(tab) {
  if (!settings.tabMeta) return '';

  const parts = [];
  const alias = getNode(tab.id)?.customTitle?.trim();
  if (alias && tab.title && alias !== tab.title) {
    parts.push(tab.title);
  }
  parts.push(domainOf(tab.url));
  if (tab.groupId != null && tab.groupId !== -1 && !settings.groups && groups[tab.groupId]?.title) {
    parts.push(groups[tab.groupId].title);
  }
  return hl(parts.join(' · '), query);
}

function isFocusedItem(kind, id) {
  return focusedKey === focusKeyFor(kind, id);
}

function tabRow(tab, options = {}) {
  const node = getNode(tab.id) || {};
  const hasKids = !!node.children?.length;
  const isActive = tab.id === activeId;
  const isHighlighted = highlightedIds.has(tab.id);
  const fallback = displayTitle(tab).slice(0, 1).toUpperCase();
  const depthValue = options.depthOverride ?? (tab.pinned ? 0 : depth(tab.id));
  const extraClass = options.extraClass || '';
  const styleAttr = options.style ? ` style="${esc(options.style)}"` : '';
  const isEditing = editingTabId === tab.id;
  const tabFocusKey = focusKeyFor('tab', tab.id);

  return `
    <div class="${tab.pinned ? 'pin-row' : 'tab-row'} ${extraClass} ${isActive ? 'is-active' : ''} ${isHighlighted ? 'is-highlighted' : ''} ${isFocusedItem('tab', tab.id) ? 'is-focused' : ''}" data-id="${tab.id}" data-url="${esc(tab.url || '')}" data-focus-key="${tabFocusKey}" role="treeitem" aria-selected="${isHighlighted}" ${tab.pinned ? '' : `aria-expanded="${hasKids ? String(!node.collapsed) : 'false'}"`} tabindex="${isFocusedItem('tab', tab.id) ? '0' : '-1'}" draggable="true"${styleAttr}>
      ${tab.pinned ? '' : indentMarkup(depthValue)}
      ${tab.pinned
        ? `<button class="pin-mark" data-pin-toggle="${tab.id}" title="Unpin tab" aria-label="Unpin tab">${icoPin()}</button>`
        : `<button class="tab-exp ${hasKids ? '' : 'is-leaf'} ${(node.collapsed && hasKids) ? 'is-collapsed' : ''}" data-exp="${tab.id}">
            <svg viewBox="0 0 9 9"><polyline points="1.5,2.5 4.5,6 7.5,2.5"/></svg>
          </button>`}
      ${favMarkup(tab, fallback)}
      <div class="tab-copy">
        ${isEditing ? `<input class="inline-edit" data-inline-edit="tab" data-edit-id="${tab.id}" value="${esc(getNode(tab.id)?.customTitle?.trim() || displayTitle(tab))}" aria-label="Rename tab">` : `<span class="tab-title">${hl(displayTitle(tab), query)}</span>`}
        ${settings.tabMeta ? `<span class="tab-meta">${tabMeta(tab)}</span>` : ''}
      </div>
      <div class="tab-badges">${tabBadges(tab)}</div>
      ${isEditing ? '' : `<button class="tab-x" data-close="${tab.id}" title="Close tab" aria-label="Close tab">${icoX()}</button>`}
    </div>
  `;
}

function groupRow(groupId, count) {
  const group = groups[groupId];
  if (!group) return '';
  const isEditing = editingGroupId === groupId;

  return `
    <div class="group-row ${isFocusedItem('group', groupId) ? 'is-focused' : ''}" data-group-id="${groupId}" data-focus-key="${focusKeyFor('group', groupId)}" role="treeitem" aria-expanded="${String(!group.collapsed)}" tabindex="${isFocusedItem('group', groupId) ? '0' : '-1'}" draggable="true">
      <span class="group-color" style="--group-color:${groupColor(group.color)}"></span>
      <button class="group-exp ${group.collapsed ? 'is-collapsed' : ''}" data-group-toggle="${groupId}">
        <svg viewBox="0 0 9 9"><polyline points="1.5,2.5 4.5,6 7.5,2.5"/></svg>
      </button>
      <div class="group-copy">
        ${isEditing ? `<input class="inline-edit" data-inline-edit="group" data-edit-id="${groupId}" value="${esc(group.title || '')}" aria-label="Rename group">` : `<span class="group-title">${hl(group.title || 'Unnamed group', query)}</span>`}
        <span class="group-meta">${count} tab${count === 1 ? '' : 's'} · ${group.color}</span>
      </div>
      <span class="mini-count">${count}</span>
      ${isEditing ? '' : `<button class="row-menu" data-group-menu="${groupId}" title="Group actions">⋯</button>`}
    </div>
  `;
}

function folderRow(folderId, count, expanded) {
  const folder = folders[folderId];
  if (!folder) return '';
  const isEditing = editingFolderId === folderId;

  return `
    <div class="folder-row ${expanded ? '' : 'is-collapsed'} ${isFocusedItem('folder', folderId) ? 'is-focused' : ''}" data-folder-id="${folderId}" data-focus-key="${focusKeyFor('folder', folderId)}" role="treeitem" aria-expanded="${String(expanded)}" tabindex="${isFocusedItem('folder', folderId) ? '0' : '-1'}" draggable="true">
      <button class="folder-exp ${expanded ? '' : 'is-collapsed'}" data-folder-toggle="${folderId}">
        <svg viewBox="0 0 9 9"><polyline points="1.5,2.5 4.5,6 7.5,2.5"/></svg>
      </button>
      <span class="folder-icon">${icoFolder()}</span>
      <div class="folder-copy">
        ${isEditing ? `<input class="inline-edit" data-inline-edit="folder" data-edit-id="${folderId}" value="${esc(folder.title || 'Folder')}" aria-label="Rename folder">` : `<span class="folder-title">${hl(folder.title || 'Folder', query)}</span>`}
        <span class="folder-meta">${count} tab${count === 1 ? '' : 's'}</span>
      </div>
      <span class="mini-count">${count}</span>
      ${isEditing ? '' : `<button class="row-menu" data-folder-menu="${folderId}" title="Folder actions">⋯</button>`}
    </div>
  `;
}

function groupTabIds(groupId) {
  return tabs
    .filter((tab) => !tab.pinned && !getNode(tab.id)?.folderId && tab.groupId === groupId)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);
}

function folderTabIds(folderId) {
  return (getFolder(folderId)?.tabIds || [])
    .map((tabId) => getTab(tabId))
    .filter((tab) => tab && !tab.pinned)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);
}

function scheduleRenderTabs() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    if (panel === 'tabs') renderTabs({ restoreFocus: false });
  });
}

function renderTabs({ restoreFocus = true } = {}) {
  const tabsList = $('tabs-list');
  const scrollTop = tabsList?.scrollTop || 0;
  const matches = matchedTabIds();
  const orderedTabs = treeOrder().map(getTab).filter(Boolean).filter((tab) => tabInCurrentView(tab));
  const folderStates = folderQueryState(orderedTabs, matches);
  const currentSmartFolders = smartFoldersInCurrentView();
  const visibleGroupIds = new Set(
    orderedTabs
      .filter((tab) => !getNode(tab.id)?.folderId && visibleStandaloneTab(tab, matches))
      .map((tab) => tab.groupId)
      .filter((groupId) => groupId != null && groupId !== -1),
  );
  const groupCounts = new Map();
  orderedTabs.forEach((tab) => {
    const groupId = tab.groupId ?? -1;
    if (tab.pinned || groupId === -1 || getNode(tab.id)?.folderId) return;
    groupCounts.set(groupId, (groupCounts.get(groupId) || 0) + 1);
  });

  visibleTabSequence = [];
  renderFavoritesSection();

  const pinnedTabs = tabs
    .filter((tab) => tab.pinned && tabInCurrentView(tab) && (matches ? matches.has(tab.id) : true))
    .sort((a, b) => a.index - b.index);

  $('pins-wrap').classList.toggle('hidden', pinnedTabs.length === 0);
  $('pins-wrap').classList.toggle('is-collapsed', !!settings.pinnedCollapsed);
  $('pins-count').textContent = pinnedTabs.length ? `${pinnedTabs.length}` : '';
  $('btn-toggle-pins')?.setAttribute('aria-expanded', String(!settings.pinnedCollapsed));
  $('btn-toggle-pins')?.setAttribute('title', settings.pinnedCollapsed ? 'Expand pinned tabs' : 'Collapse pinned tabs');
  $('btn-toggle-pins')?.setAttribute('aria-label', settings.pinnedCollapsed ? 'Expand pinned tabs' : 'Collapse pinned tabs');
  $('pins-list').innerHTML = pinnedTabs.map((tab) => {
    if (!settings.pinnedCollapsed) visibleTabSequence.push(tab.id);
    return tabRow(tab);
  }).join('');

  const rows = [];
  const renderedGroups = new Set();
  const renderedFolders = new Set();
  const renderedSmartTabIds = new Set();

  currentSmartFolders.forEach((folder) => {
    const members = smartFolderMembers(folder);
    const titleHit = query
      ? fuzzyIncludes(query.toLowerCase(), folder.title || '') || fuzzyIncludes(query.toLowerCase(), folder.query || '')
      : false;
    const shouldShow = !query || titleHit || members.some((tab) => matches?.has(tab.id));
    if (!shouldShow || !members.length) return;

    rows.push(smartFolderRow(folder, members.length));

    if (folder.collapsed) {
      if (smartFolderPreviewId === folder.id) {
        rows.push(folderPreviewMarkup(folder.id, members, 'smart-folder'));
      }
      return;
    }

    members.forEach((tab) => {
      renderedSmartTabIds.add(tab.id);
      visibleTabSequence.push(tab.id);
      rows.push(tabRow(tab, { extraClass: 'in-folder in-smart-folder', depthOverride: 1 }));
    });
  });

  for (const tab of orderedTabs) {
    if (tab.pinned) continue;
    if (renderedSmartTabIds.has(tab.id)) continue;

    const node = getNode(tab.id) || {};
    const folderId = node.folderId;

    if (folderId && folders[folderId]) {
      const state = folderStates.get(folderId);
      if (!state?.show) continue;

      if (!renderedFolders.has(folderId)) {
        rows.push(folderRow(folderId, state.tabIds.length, state.expand));
        renderedFolders.add(folderId);
      }

      if (!state.expand) continue;
      if (!query && hasCollapsedAncestor(tab.id)) continue;
      if (query && !state.titleHit && !state.matchIds.has(tab.id)) continue;

      visibleTabSequence.push(tab.id);
      const groupId = tab.groupId ?? -1;
      rows.push(tabRow(tab, {
        extraClass: `in-folder ${groupId !== -1 ? 'in-group' : ''}`,
        depthOverride: depth(tab.id) + 1,
        style: groupId !== -1 ? `--group-color:${groupColor(groups[groupId]?.color)}` : '',
      }));
      continue;
    }

    const visible = visibleStandaloneTab(tab, matches);
    const groupId = tab.groupId ?? -1;
    if (settings.groups && groupId !== -1 && !renderedGroups.has(groupId) && (!matches || visibleGroupIds.has(groupId))) {
      rows.push(groupRow(groupId, groupCounts.get(groupId) || 0));
      renderedGroups.add(groupId);
    }

    if (!visible) continue;
    visibleTabSequence.push(tab.id);
    if (settings.groups && groupId !== -1) {
      rows.push(tabRow(tab, {
        extraClass: 'in-group',
        depthOverride: depth(tab.id) + 1,
        style: `--group-color:${groupColor(groups[groupId]?.color)}`,
      }));
      continue;
    }
    rows.push(tabRow(tab));
  }

  Object.values(folders)
    .filter((folder) => !renderedFolders.has(folder.id) && !query && (folder.tabIds || []).some((tabId) => {
      const tab = getTab(tabId);
      return !!tab && tabInCurrentView(tab);
    }))
    .sort((a, b) => (a.sortIndex ?? Number.MAX_SAFE_INTEGER) - (b.sortIndex ?? Number.MAX_SAFE_INTEGER))
    .forEach((folder) => {
      const visibleCount = (folder.tabIds || []).map(getTab).filter(Boolean).filter((tab) => tabInCurrentView(tab)).length;
      rows.push(folderRow(folder.id, visibleCount, !folder.collapsed));
      if (folder.collapsed && folderPreviewId === folder.id) {
        const previewTabs = (folder.tabIds || []).map(getTab).filter(Boolean).filter((tab) => tabInCurrentView(tab));
        rows.push(folderPreviewMarkup(folder.id, previewTabs, 'folder'));
      }
    });

  const virtualRows = virtualizeRows(rows, {
    scrollTop,
    viewportHeight: tabsList?.clientHeight || window.innerHeight,
    rowHeight: settings.compact ? 32 : 41,
    overscan: 10,
    threshold: 260,
  });
  const topSpacer = virtualRows.topSpacer
    ? `<div class="virtual-spacer" style="height:${virtualRows.topSpacer}px"></div>`
    : '';
  const bottomSpacer = virtualRows.bottomSpacer
    ? `<div class="virtual-spacer" style="height:${virtualRows.bottomSpacer}px"></div>`
    : '';
  const virtualNotice = virtualRows.virtualized
    ? `<div class="virtual-more" role="note">Showing rows ${virtualRows.startIndex + 1}-${virtualRows.endIndex} of ${rows.length}. Search narrows the list instantly.</div>`
    : '';

  tabsList.innerHTML = virtualRows.rows.length
    ? `${topSpacer}${virtualRows.rows.join('')}${bottomSpacer}${virtualNotice}`
    : `<div class="empty"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="4" width="14" height="2.5" rx="1.25"/><rect x="3" y="8.75" width="14" height="2.5" rx="1.25"/><rect x="3" y="13.5" width="14" height="2.5" rx="1.25"/></svg><span>No tabs match this view</span></div>`;
  tabsList.scrollTop = scrollTop;

  bindTabInteractions($('pins-list'));
  bindTabInteractions(tabsList);
  bindGroupInteractions();
  bindFolderInteractions();
  bindSmartFolderInteractions();
  bindFolderPreviewInteractions();
  bindInlineEditors();
  renderSummary();
  if (restoreFocus) restoreFocusedRow();
}

function visibleFocusableRows() {
  if (panel === 'tabs') {
    return [
      ...document.querySelectorAll('#pins-list [data-focus-key], #tabs-list [data-focus-key]'),
    ];
  }

  if (panel === 'bookmarks') {
    return [...document.querySelectorAll('#bookmarks-list [data-focus-key]')];
  }

  if (panel === 'history') {
    return [
      ...document.querySelectorAll('#snapshots-list [data-focus-key], #archived-list [data-focus-key], #recently-closed-list [data-focus-key], #history-list [data-focus-key]'),
    ];
  }

  return [];
}

function restoreFocusedRow() {
  const rows = visibleFocusableRows();
  if (!rows.length) {
    focusedKey = '';
    return;
  }

  let row = focusedKey ? rows.find((candidate) => candidate.dataset.focusKey === focusedKey) : null;
  if (!row) {
    const defaultTabId = activeId ?? visibleTabSequence[0];
    if (defaultTabId != null) {
      focusedKey = focusKeyFor('tab', defaultTabId);
      row = rows.find((candidate) => candidate.dataset.focusKey === focusedKey);
    }
  }

  if (!row) {
    row = rows[0];
    focusedKey = row.dataset.focusKey || '';
  }

  setFocusedKey(row.dataset.focusKey);
}

function setFocusedKey(nextKey, { focus = false } = {}) {
  focusedKey = nextKey || '';
  const rows = visibleFocusableRows();
  rows.forEach((row) => {
    const isTarget = row.dataset.focusKey === focusedKey;
    row.tabIndex = isTarget ? 0 : -1;
    row.classList.toggle('is-focused', isTarget);
    if (focus && isTarget) {
      row.focus({ preventScroll: false });
    }
  });
}

function focusSearchResults(direction = 1) {
  const rows = visibleFocusableRows();
  if (!rows.length) return;
  const target = direction < 0 ? rows[rows.length - 1] : rows[0];
  setFocusedKey(target.dataset.focusKey, { focus: true });
}

function startEditTab(tabId) {
  clearEditingState();
  editingTabId = tabId;
  renderTabs();
  requestAnimationFrame(() => {
    const input = document.querySelector(`.inline-edit[data-inline-edit="tab"][data-edit-id="${tabId}"]`);
    input?.focus();
    input?.select();
  });
}

function startEditFolder(folderId) {
  clearEditingState();
  editingFolderId = folderId;
  renderTabs();
  requestAnimationFrame(() => {
    const input = document.querySelector(`.inline-edit[data-inline-edit="folder"][data-edit-id="${folderId}"]`);
    input?.focus();
    input?.select();
  });
}

function startEditGroup(groupId) {
  clearEditingState();
  editingGroupId = groupId;
  renderTabs();
  requestAnimationFrame(() => {
    const input = document.querySelector(`.inline-edit[data-inline-edit="group"][data-edit-id="${groupId}"]`);
    input?.focus();
    input?.select();
  });
}

function startEditSnapshot(snapshotId) {
  clearEditingState();
  editingSnapshotId = snapshotId;
  if (panel !== 'history') switchPanel('history');
  else renderSnapshots();
  requestAnimationFrame(() => {
    const input = document.querySelector(`.inline-edit[data-inline-edit="snapshot"][data-edit-id="${snapshotId}"]`);
    input?.focus();
    input?.select();
  });
}

function stopEditing() {
  if (
    editingTabId == null
    && editingFolderId == null
    && editingGroupId == null
    && editingSnapshotId == null
    && editingSmartFolderId == null
  ) return;
  clearEditingState();
  if (panel === 'tabs') {
    renderTabs();
    renderQuickActions();
    return;
  }
  if (panel === 'history') {
    renderSnapshots();
  }
}

function bindInlineEditors() {
  document.querySelectorAll('.inline-edit').forEach((input) => {
    const type = input.dataset.inlineEdit;
    const editId = input.dataset.editId;
    let finished = false;

    const commit = async () => {
      if (finished) return;
      finished = true;
      const nextValue = input.value;
      if (type === 'tab') {
        await send({ type: 'RENAME_TAB', windowId: winId, tabId: Number(editId), title: nextValue });
      } else if (type === 'group') {
        await send({ type: 'RENAME_GROUP', groupId: Number(editId), title: nextValue });
      } else if (type === 'folder') {
        await send({ type: 'RENAME_FOLDER', windowId: winId, folderId: editId, title: nextValue });
      } else if (type === 'snapshot') {
        await send({ type: 'RENAME_SNAPSHOT', snapshotId: editId, title: nextValue });
        await loadSavedSnapshots();
      } else if (type === 'smart-folder') {
        await send({
          type: 'UPDATE_SMART_FOLDER',
          folderId: editId,
          folder: {
            ...(smartFolders.find((folder) => folder.id === editId) || {}),
            title: nextValue,
          },
        });
        await loadSmartFolders();
      }
      clearEditingState();
      if (panel === 'tabs') {
        renderTabs();
        renderQuickActions();
      } else if (panel === 'history') {
        renderSnapshots();
      }
    };

    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        await commit();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finished = true;
        clearEditingState();
        if (panel === 'tabs') {
          renderTabs();
          renderQuickActions();
        } else if (panel === 'history') {
          renderSnapshots();
        }
      }
    });
    input.addEventListener('blur', () => {
      commit();
    });
  });
}

function currentBmFolder() {
  return bmPath.length ? bmPath[bmPath.length - 1] : bmCache?.[0];
}

async function loadBookmarks() {
  const result = await send({ type: 'GET_BOOKMARKS' });
  bmCache = result.tree;
  renderBookmarks();
  updateNavCounts();
}

function renderBookmarks() {
  const folder = currentBmFolder();
  if (!folder) return;

  const q = query.toLowerCase();
  const children = folder.children || [];
  const items = q
    ? children.filter((item) => [item.title, item.url].filter(Boolean).join('\n').toLowerCase().includes(q))
    : children;

  const path = [{ title: 'Bookmarks', node: bmCache?.[0] }, ...bmPath.map((node) => ({ title: node.title || 'Folder', node }))];
  $('bookmarks-crumb').innerHTML = path
    .map((entry, index) => `${index ? '<span class="bc-sep">›</span>' : ''}<span class="bc-item" data-nav="${index}">${esc(entry.title)}</span>`)
    .join('');

  $('bookmarks-crumb').querySelectorAll('[data-nav]').forEach((element) => {
    const index = Number(element.dataset.nav);
    element.onclick = () => {
      if (index < path.length - 1) {
        bmPath = bmPath.slice(0, index);
        renderBookmarks();
      }
    };
  });

  if (!items.length) {
    $('bookmarks-list').innerHTML = `<div class="empty"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 3h10a1 1 0 0 1 1 1v13l-6-3-6 3V4a1 1 0 0 1 1-1z"/></svg><span>${query ? 'No bookmarks match this search' : 'This bookmark folder is empty'}</span></div>`;
    return;
  }

  $('bookmarks-list').innerHTML = items
    .map((item) => {
      const isFolder = !item.url;
      return `
        <div class="bm-row ${isFolder ? 'is-folder' : ''} ${isFocusedItem('bookmark', item.id) ? 'is-focused' : ''}" data-id="${item.id}" data-url="${esc(item.url || '')}" data-focus-key="${focusKeyFor('bookmark', item.id)}" tabindex="${isFocusedItem('bookmark', item.id) ? '0' : '-1'}" role="button" aria-label="${esc(item.title || 'Bookmark')}">
          ${isFolder ? `<span class="bm-folder">${icoFolder()}</span>` : itemIconMarkup(item.url, (item.title || '?').slice(0, 1).toUpperCase(), 'bm-icon')}
          <div class="item-copy">
            <span class="item-title">${hl(item.title || 'Untitled', query)}</span>
            <span class="item-meta">${isFolder ? `${item.children?.length || 0} items` : hl(domainOf(item.url), query)}</span>
          </div>
          ${isFolder ? `<span class="mini-count">${item.children?.length || 0}</span>` : ''}
        </div>
      `;
    })
    .join('');

  $('bookmarks-list').querySelectorAll('.bm-row').forEach((row) => {
    const node = items.find((item) => item.id === row.dataset.id);
    if (!node) return;
    const focusKey = row.dataset.focusKey;

    row.addEventListener('focus', () => setFocusedKey(focusKey));

    row.onclick = () => {
      setFocusedKey(focusKey);
      if (node.url) {
        send({ type: 'OPEN_BOOKMARK', url: node.url, newTab: false });
      } else {
        bmPath.push(node);
        renderBookmarks();
      }
    };

    row.oncontextmenu = (event) => {
      event.preventDefault();
      bmCtxMenu(event, node);
    };
  });

  if (panel === 'bookmarks') restoreFocusedRow();
}

async function loadHistory() {
  const range = Number($('history-range').value);
  const result = await send({
    type: 'GET_HISTORY',
    query,
    maxResults: 250,
    startTime: range ? Date.now() - range : 0,
  });

  historyCache = result.items;
  renderHistory(historyCache);
}

function renderHistory(items) {
  if (!items?.length) {
    $('history-list').innerHTML = `<div class="empty"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="10" cy="10" r="7.5"/><polyline points="10,6 10,10 13,12.5"/></svg><span>${query ? 'No history matches this search' : 'No history for this range'}</span></div>`;
    return;
  }

  const rows = [];
  let lastDate = '';

  items.forEach((item) => {
    const label = fmtDate(item.lastVisitTime);
    if (label !== lastDate) {
      rows.push(`<div class="section-head"><span>${label}</span><span></span></div>`);
      lastDate = label;
    }

    rows.push(`
      <div class="h-row ${isFocusedItem('history', item.url) ? 'is-focused' : ''}" data-url="${esc(item.url)}" data-focus-key="${focusKeyFor('history', item.url)}" tabindex="${isFocusedItem('history', item.url) ? '0' : '-1'}" role="button" aria-label="${esc(item.title || item.url)}">
        ${itemIconMarkup(item.url, 'H', 'h-fav')}
        <div class="item-copy">
          <span class="item-title">${hl(item.title || item.url, query)}</span>
          <span class="item-meta">${hl(domainOf(item.url), query)}</span>
        </div>
        <span class="h-time">${fmtTime(item.lastVisitTime)}</span>
      </div>
    `);
  });

  $('history-list').innerHTML = rows.join('');
  $('history-list').querySelectorAll('.h-row').forEach((row) => {
    row.addEventListener('focus', () => setFocusedKey(row.dataset.focusKey));
    row.onclick = () => {
      setFocusedKey(row.dataset.focusKey);
      send({ type: 'OPEN_BOOKMARK', url: row.dataset.url, newTab: false });
    };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      historyCtxMenu(event, row.dataset.url);
    };
  });

  if (panel === 'history') restoreFocusedRow();
}

function renderRecentlyClosed() {
  const q = query.toLowerCase();
  const items = q
    ? recentlyClosed.filter((item) => [item.title, item.url].filter(Boolean).join('\n').toLowerCase().includes(q))
    : recentlyClosed;

  $('closed-count').textContent = items.length ? `${items.length}` : '';

  $('recently-closed-list').innerHTML = items.length
    ? items
        .map(
          (item) => `
            <div class="closed-row ${isFocusedItem('closed', item.sessionId) ? 'is-focused' : ''}" data-session-id="${item.sessionId}" data-url="${esc(item.url || '')}" data-focus-key="${focusKeyFor('closed', item.sessionId)}" tabindex="${isFocusedItem('closed', item.sessionId) ? '0' : '-1'}" role="button" aria-label="${esc(item.title)}">
              ${itemIconMarkup(item.url, '↺', 'closed-fav')}
              <div class="item-copy">
                <span class="item-title">${hl(item.title, query)}</span>
                <span class="item-meta">${item.kind === 'window' ? `${item.count || 0} tabs` : hl(domainOf(item.url), query)}</span>
              </div>
              <button class="row-menu" data-restore-session="${item.sessionId}" title="Restore">↺</button>
            </div>
          `,
        )
        .join('')
    : `<div class="empty"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 8a7 7 0 1 0 2-4.8"/><polyline points="2,2 6,2 6,6"/></svg><span>${query ? 'No closed tabs match this search' : 'No recently closed tabs'}</span></div>`;

  $('recently-closed-list').querySelectorAll('.closed-row').forEach((row) => {
    const sessionId = row.dataset.sessionId;
    row.addEventListener('focus', () => setFocusedKey(row.dataset.focusKey));
    row.onclick = () => {
      setFocusedKey(row.dataset.focusKey);
      send({ type: 'RESTORE_SESSION', sessionId });
    };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      closedCtxMenu(event, sessionId, row.dataset.url);
    };
  });

  if (panel === 'history') restoreFocusedRow();
}

async function loadSavedSnapshots() {
  const result = await send({ type: 'GET_SAVED_SNAPSHOTS' });
  savedSnapshots = result.snapshots || [];
  renderSnapshots();
  updateNavCounts();
}

function renderSnapshots() {
  const q = query.toLowerCase();
  const items = q
    ? savedSnapshots.filter((snapshot) =>
        [
          snapshot.title,
          ...((snapshot.entries || []).slice(0, 8).map((entry) => entry.title || entry.url || '')),
        ]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
          .includes(q),
      )
    : savedSnapshots;

  $('snapshots-count').textContent = items.length ? `${items.length}` : '';
  $('snapshots-list').innerHTML = items.length
    ? items
        .map((snapshot) => {
          const isEditing = editingSnapshotId === snapshot.id;
          const preview = (snapshot.entries || [])
            .slice(0, 3)
            .map((entry) => entry.customTitle || entry.title || domainOf(entry.url))
            .filter(Boolean)
            .join(' · ');
          return `
            <div class="snapshot-row ${isFocusedItem('snapshot', snapshot.id) ? 'is-focused' : ''}" data-snapshot-id="${snapshot.id}" data-focus-key="${focusKeyFor('snapshot', snapshot.id)}" tabindex="${isFocusedItem('snapshot', snapshot.id) ? '0' : '-1'}" role="button" aria-label="${esc(snapshot.title || 'Saved snapshot')}">
              <div class="tab-fav-ph snapshot-fav">S</div>
              <div class="snapshot-copy">
                ${isEditing ? `<input class="inline-edit" data-inline-edit="snapshot" data-edit-id="${snapshot.id}" value="${esc(snapshot.title || 'Saved tabs')}" aria-label="Rename snapshot">` : `<span class="snapshot-title">${esc(snapshot.title || 'Saved tabs')}</span>`}
                <span class="snapshot-meta">${snapshot.entryCount || snapshot.entries?.length || 0} tabs · ${fmtDate(snapshot.createdAt)} ${fmtTime(snapshot.createdAt)}</span>
                <span class="snapshot-preview">${esc(preview || 'Restore this saved tab set in a new window')}</span>
              </div>
              ${isEditing ? '' : `<button class="row-menu" data-snapshot-menu="${snapshot.id}" title="Snapshot actions">⋯</button>`}
            </div>
          `;
        })
        .join('')
    : `<div class="empty"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 5.5h12M4 10h12M4 14.5h12"/></svg><span>${query ? 'No snapshots match this search' : 'No saved snapshots yet'}</span></div>`;

  $('snapshots-list').querySelectorAll('.snapshot-row').forEach((row) => {
    const snapshotId = row.dataset.snapshotId;
    const focusKey = row.dataset.focusKey;
    row.addEventListener('focus', () => setFocusedKey(focusKey));
    row.onclick = async (event) => {
      if (event.target.closest('[data-snapshot-menu]')) return;
      setFocusedKey(focusKey);
      await send({ type: 'RESTORE_SNAPSHOT', snapshotId });
    };
    row.ondblclick = (event) => {
      if (event.target.closest('[data-snapshot-menu]')) return;
      startEditSnapshot(snapshotId);
    };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      snapshotCtxMenu(event, snapshotId);
    };
  });

  $('snapshots-list').querySelectorAll('[data-snapshot-menu]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      snapshotCtxMenu(event, button.dataset.snapshotMenu);
    };
  });

  bindInlineEditors();
  if (panel === 'history') restoreFocusedRow();
}

function applySnapshot(snapshot) {
  tabs = snapshot.tabs || [];
  tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  tree = snapshot.tree || {};
  groups = snapshot.groups || {};
  folders = snapshot.folders || {};
  recentlyClosed = snapshot.recentlyClosed || [];
  winId = snapshot.windowId;
  activeId = tabs.find((tab) => tab.active)?.id ?? activeId;
  highlightedIds = new Set(tabs.filter((tab) => tab.highlighted).map((tab) => tab.id));
  reconcileSelectionState();

  renderFavoritesSection();
  renderSummary();
  updateNavCounts();
  updateSelectionBar();
  renderRecentlyClosed();

  if (panel === 'tabs') {
    renderQuickActions();
    renderTabs();
    loadUndoState();
  }
}

function switchPanel(nextPanel) {
  panelQueries[panel] = query;
  panel = nextPanel;
  settings.lastPanel = nextPanel;
  scheduleSaveSettings();
  query = panelQueries[nextPanel] || '';
  document.querySelectorAll('.panel').forEach((node) => node.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-panel]').forEach((node) => node.classList.remove('active'));
  $(`panel-${nextPanel}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-panel="${nextPanel}"]`)?.classList.add('active');
  $('tree-controls').style.display = nextPanel === 'tabs' ? '' : 'none';
  $('search-input').value = query;
  $('search-clear').classList.toggle('show', !!query);

  if (nextPanel === 'tabs') {
    renderQuickActions();
    renderTabs();
    loadUndoState();
  }
  if (nextPanel === 'bookmarks') loadBookmarks();
  if (nextPanel === 'history') {
    renderSnapshots();
    renderRecentlyClosed();
    renderArchivedTabs();
    loadSavedSnapshots();
    loadArchivedTabs();
    loadHistory();
  }
}

function clearSearch() {
  setCurrentQuery('');
  if (panel === 'tabs') renderTabs();
  if (panel === 'bookmarks') renderBookmarks();
  if (panel === 'history') {
    renderSnapshots();
    renderRecentlyClosed();
    loadHistory();
  }
}

function selectedTabIdsFor(tabId) {
  if (highlightedIds.has(tabId) && highlightedIds.size > 1) {
    return visibleTabSequence.filter((id) => highlightedIds.has(id));
  }
  return [tabId];
}

function handleSingleSelection(tabId) {
  lastSelectionAnchorId = tabId;
  send({ type: 'HIGHLIGHT_TABS', windowId: winId, tabIds: [tabId], activeId: tabId });
}

function handleRangeSelection(tabId) {
  const anchorId = lastSelectionAnchorId ?? activeId ?? tabId;
  const tabIds = selectedIdsForRange(visibleTabSequence, anchorId, tabId);
  if (!tabIds.length || (tabIds.length === 1 && tabIds[0] === tabId && anchorId !== tabId)) {
    handleSingleSelection(tabId);
    return;
  }

  send({ type: 'HIGHLIGHT_TABS', windowId: winId, tabIds, activeId: tabId });
}

function handleToggleSelection(tabId) {
  const next = new Set(highlightedIds);
  if (next.has(tabId) && next.size > 1) next.delete(tabId);
  else next.add(tabId);
  lastSelectionAnchorId = tabId;
  send({ type: 'HIGHLIGHT_TABS', windowId: winId, tabIds: [...next], activeId: tabId });
}

function clearSelectionToActive() {
  if (highlightedIds.size <= 1) return false;
  const nextActiveId = activeId ?? currentSelectedTabIds()[0];
  if (nextActiveId == null) return false;
  lastSelectionAnchorId = nextActiveId;
  send({ type: 'HIGHLIGHT_TABS', windowId: winId, tabIds: [nextActiveId], activeId: nextActiveId });
  return true;
}

async function promptCreateFolder(tabIds) {
  const eligibleTabIds = [...new Set(tabIds)].filter((tabId) => !getTab(tabId)?.pinned);
  if (!eligibleTabIds.length) {
    showToast('Pinned tabs cannot be added to folders yet');
    return;
  }

  const result = await send({ type: 'CREATE_FOLDER_FROM_TABS', windowId: winId, tabIds: eligibleTabIds, title: 'Folder' });
  const folderId = result?.folder?.id;
  if (folderId) {
    clearEditingState();
    editingFolderId = folderId;
    renderTabs();
  }
}

async function convertFolderToGroup(folderId) {
  const folder = getFolder(folderId);
  const tabIds = folderTabIds(folderId);
  if (!folder || !tabIds.length) return;

  const result = await send({
    type: 'BATCH_GROUP_TABS',
    windowId: winId,
    tabIds,
    title: folder.title || 'Folder',
    color: 'blue',
  });
  await send({ type: 'REMOVE_FOLDER', windowId: winId, folderId });
  if (result?.groupId != null) startEditGroup(result.groupId);
}

async function convertGroupToFolder(groupId) {
  const group = groups[groupId];
  const tabIds = groupTabIds(groupId);
  if (!group || !tabIds.length) return;

  const result = await send({
    type: 'CREATE_FOLDER_FROM_TABS',
    windowId: winId,
    tabIds,
    title: group.title || 'Group',
  });
  await send({ type: 'UNGROUP_ALL', windowId: winId, groupId });
  if (result?.folder?.id) startEditFolder(result.folder.id);
}

function currentDragSelection(tabId) {
  if (highlightedIds.has(tabId) && highlightedIds.size > 1) {
    return currentSelectedTabIds().filter((selectedId) => !getTab(selectedId)?.pinned);
  }
  return [tabId];
}

function bindTabInteractions(container) {
  if (!container) return;

  container.querySelectorAll('.tab-row, .pin-row').forEach((row) => {
    const tabId = Number(row.dataset.id);
    const url = row.dataset.url;
    const tabFocusKey = row.dataset.focusKey;

    row.addEventListener('focus', () => {
      setFocusedKey(tabFocusKey);
    });

    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-exp]')) return;
      if (event.target.closest('[data-close]')) return;
      if (event.target.closest('[data-pin-toggle]')) return;
      if (event.target.closest('.inline-edit')) return;
      setFocusedKey(tabFocusKey);

      if (event.shiftKey) {
        event.preventDefault();
        handleRangeSelection(tabId);
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        handleToggleSelection(tabId);
        return;
      }

      handleSingleSelection(tabId);
    });

    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('[data-exp]') || event.target.closest('[data-close]') || event.target.closest('[data-pin-toggle]')) return;
      startEditTab(tabId);
    });

    row.querySelector('[data-exp]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const node = getNode(tabId);
      if (!node?.children?.length) return;
      node.collapsed = !node.collapsed;
      send({ type: 'SET_COLLAPSED', windowId: winId, tabId, collapsed: node.collapsed });
      renderTabs();
    });

    row.querySelector('[data-close]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      send({ type: 'CLOSE_TAB', tabId });
    });

    row.querySelector('[data-pin-toggle]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      send({ type: 'PIN_TAB', tabId, pinned: false });
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      tabCtxMenu(event, tabId);
    });

    if (settings.urlHover) {
      row.addEventListener('mouseenter', () => showUrl(url));
      row.addEventListener('mouseleave', hideUrl);
    }

    row.addEventListener('dragstart', (event) => {
      dragTabId = tabId;
      dragTabIds = currentDragSelection(tabId);
      document.body.classList.add('is-dragging-tabs');
      event.dataTransfer.setData('text/plain', String(tabId));
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      dragTabId = null;
      dragTabIds = [];
      document.body.classList.remove('is-dragging-tabs');
      clearDropHints();
      folderExpander.cancel();
      autoScroller.stop();
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      autoScroller.queue(container, event);
      if (dragTabId == null || dragTabId === tabId) return;
      clearDropHints();
      const position = row.classList.contains('pin-row') ? (dropModeForEvent(event, row) === 'before' ? 'before' : 'after') : dropModeForEvent(event, row);
      setDropHint(row, position, position === 'inside' ? 'Nest tab here' : '');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
      delete row.dataset.dropLabel;
      autoScroller.stop();
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromId = Number(event.dataTransfer.getData('text/plain') || dragTabId);
      if (!fromId || fromId === tabId) return;
      const position = row.classList.contains('pin-row') ? (dropModeForEvent(event, row) === 'before' ? 'before' : 'after') : dropModeForEvent(event, row);
      clearDropHints();
      folderExpander.cancel();
      autoScroller.stop();
      document.body.classList.remove('is-dragging-tabs');
      send({ type: 'MOVE_TAB_IN_TREE', windowId: winId, tabId: fromId, targetId: tabId, position });
    });
  });

  container.ondragover = (event) => {
    event.preventDefault();
    autoScroller.queue(container, event);
  };

  container.ondrop = (event) => {
    if (event.target.closest('.tab-row, .pin-row')) return;
    autoScroller.stop();
    folderExpander.cancel();
    document.body.classList.remove('is-dragging-tabs');
    if (folderDragId && container.id === 'tabs-list') {
      clearDropHints();
      send({ type: 'MOVE_FOLDER_BLOCK', windowId: winId, folderId: folderDragId, targetFolderId: null, position: 'after' });
      return;
    }
    if (groupDragId && container.id === 'tabs-list') {
      const draggedGroupId = groupDragId;
      groupDragId = null;
      dragTabIds = [];
      dragTabId = null;
      send({ type: 'MOVE_GROUP_BLOCK', windowId: winId, groupId: draggedGroupId, targetGroupId: null, position: 'after' });
      return;
    }
    const fromId = Number(event.dataTransfer.getData('text/plain') || dragTabId);
    if (!fromId) return;
    clearDropHints();
    send({ type: 'MOVE_TAB_IN_TREE', windowId: winId, tabId: fromId, targetId: null, position: 'after' });
  };
}

function bindGroupInteractions() {
  $('tabs-list').querySelectorAll('.group-row').forEach((row) => {
    const groupId = Number(row.dataset.groupId);
    const group = groups[groupId];
    const groupFocusKey = row.dataset.focusKey;

    row.addEventListener('focus', () => {
      setFocusedKey(groupFocusKey);
    });

    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-group-menu]')) return;
      if (event.target.closest('.inline-edit')) return;
      setFocusedKey(groupFocusKey);
      const collapsed = !group?.collapsed;
      send({ type: 'TOGGLE_GROUP_COLLAPSED', groupId, collapsed });
    });

    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('[data-group-menu]')) return;
      startEditGroup(groupId);
    });

    row.querySelector('[data-group-toggle]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = !group?.collapsed;
      send({ type: 'TOGGLE_GROUP_COLLAPSED', groupId, collapsed });
    });

    row.querySelector('[data-group-menu]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      groupCtxMenu(event, groupId);
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      groupCtxMenu(event, groupId);
    });

    row.addEventListener('dragstart', (event) => {
      const tabIds = groupTabIds(groupId);
      groupDragId = groupId;
      dragTabIds = tabIds;
      dragTabId = tabIds[0] ?? null;
      document.body.classList.add('is-dragging-tabs');
      event.dataTransfer.setData('text/plain', String(dragTabId || groupId));
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      groupDragId = null;
      dragTabId = null;
      dragTabIds = [];
      document.body.classList.remove('is-dragging-tabs');
      clearDropHints();
      folderExpander.cancel();
      autoScroller.stop();
    });

    row.addEventListener('dragover', (event) => {
      if (groupDragId != null) {
        if (groupDragId === groupId) return;
        event.preventDefault();
        autoScroller.queue($('tabs-list'), event);
        clearDropHints();
        const nextMode = dropModeForEvent(event, row);
        setDropHint(row, nextMode === 'before' ? 'before' : 'after');
        return;
      }
      if (dragTabId == null) return;
      event.preventDefault();
      autoScroller.queue($('tabs-list'), event);
      clearDropHints();
      setDropHint(row, 'inside', 'Add to group');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-inside');
      delete row.dataset.dropLabel;
      autoScroller.stop();
    });

    row.addEventListener('drop', async (event) => {
      event.preventDefault();
      if (groupDragId != null) {
        if (groupDragId === groupId) return;
        const draggedGroupId = groupDragId;
        const position = dropModeForEvent(event, row) === 'before' ? 'before' : 'after';
        groupDragId = null;
        dragTabId = null;
        dragTabIds = [];
        clearDropHints();
        autoScroller.stop();
        document.body.classList.remove('is-dragging-tabs');
        await send({ type: 'MOVE_GROUP_BLOCK', windowId: winId, groupId: draggedGroupId, targetGroupId: groupId, position });
        return;
      }
      const tabIds = (dragTabIds.length ? dragTabIds : [Number(event.dataTransfer.getData('text/plain') || dragTabId)])
        .filter((tabId) => tabId && getTab(tabId) && !getTab(tabId).pinned);
      clearDropHints();
      autoScroller.stop();
      document.body.classList.remove('is-dragging-tabs');
      if (!tabIds.length) return;
      await send({ type: 'MOVE_TABS_TO_GROUP', windowId: winId, tabIds, groupId });
    });
  });
}

function bindFolderInteractions() {
  $('tabs-list').querySelectorAll('.folder-row').forEach((row) => {
    const folderId = row.dataset.folderId;
    const folder = getFolder(folderId);
    const folderFocusKey = row.dataset.focusKey;

    row.addEventListener('focus', () => {
      setFocusedKey(folderFocusKey);
    });

    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-folder-toggle]')) return;
      if (event.target.closest('[data-folder-menu]')) return;
      if (event.target.closest('.inline-edit')) return;
      setFocusedKey(folderFocusKey);
      if (folder?.collapsed) {
        folderPreviewId = folderPreviewId === folderId ? '' : folderId;
        renderTabs();
        return;
      }
      const collapsed = !folder?.collapsed;
      folderPreviewId = '';
      send({ type: 'SET_FOLDER_COLLAPSED', windowId: winId, folderId, collapsed });
    });

    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('[data-folder-menu]')) return;
      startEditFolder(folderId);
    });

    row.querySelector('[data-folder-toggle]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = !folder?.collapsed;
      folderPreviewId = '';
      send({ type: 'SET_FOLDER_COLLAPSED', windowId: winId, folderId, collapsed });
    });

    row.querySelector('[data-folder-menu]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      folderCtxMenu(event, folderId);
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      folderCtxMenu(event, folderId);
    });

    row.addEventListener('dragstart', (event) => {
      folderDragId = folderId;
      document.body.classList.add('is-dragging-tabs');
      event.dataTransfer.setData('text/plain', folderId);
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      folderDragId = null;
      groupDragId = null;
      document.body.classList.remove('is-dragging-tabs');
      clearDropHints();
      folderExpander.cancel();
      autoScroller.stop();
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      autoScroller.queue($('tabs-list'), event);
      clearDropHints();

      if (folderDragId && folderDragId !== folderId) {
        const nextMode = dropModeForEvent(event, row);
        setDropHint(row, nextMode === 'before' ? 'before' : 'after');
        return;
      }

      if (groupDragId != null) {
        setDropHint(row, 'inside', 'Move group into folder');
        folderExpander.schedule(folderId);
        return;
      }

      if (dragTabId != null) {
        setDropHint(row, 'inside', 'Add to folder');
        folderExpander.schedule(folderId);
      }
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
      delete row.dataset.dropLabel;
      folderExpander.cancel();
      autoScroller.stop();
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      clearDropHints();
      folderExpander.cancel();
      autoScroller.stop();
      document.body.classList.remove('is-dragging-tabs');

      if (folderDragId && folderDragId !== folderId) {
        const position = dropModeForEvent(event, row) === 'before' ? 'before' : 'after';
        send({ type: 'MOVE_FOLDER_BLOCK', windowId: winId, folderId: folderDragId, targetFolderId: folderId, position });
        return;
      }

      if (groupDragId != null) {
        const tabIds = groupTabIds(groupDragId);
        groupDragId = null;
        dragTabIds = [];
        dragTabId = null;
        if (tabIds.length) send({ type: 'MOVE_TABS_TO_FOLDER', windowId: winId, tabIds, folderId });
        return;
      }

      if (dragTabId != null) {
        const draggedIds = dragTabIds.length ? dragTabIds : [dragTabId];
        send({ type: 'MOVE_TABS_TO_FOLDER', windowId: winId, tabIds: draggedIds, folderId });
      }
    });
  });
}

function bindSmartFolderInteractions() {
  $('tabs-list').querySelectorAll('.smart-folder-row').forEach((row) => {
    const folderId = row.dataset.smartFolderId;
    const folder = smartFolders.find((item) => item.id === folderId);
    const focusKey = row.dataset.focusKey;
    if (!folder) return;

    row.addEventListener('focus', () => setFocusedKey(focusKey));
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-smart-folder-toggle]')) return;
      if (event.target.closest('[data-smart-folder-menu]')) return;
      if (event.target.closest('.inline-edit')) return;
      setFocusedKey(focusKey);
      if (folder.collapsed) {
        smartFolderPreviewId = smartFolderPreviewId === folderId ? '' : folderId;
        renderTabs();
        return;
      }
      send({
        type: 'UPDATE_SMART_FOLDER',
        folderId,
        folder: { collapsed: true },
      }).then(loadSmartFolders);
    });
    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('[data-smart-folder-menu]')) return;
      clearEditingState();
      editingSmartFolderId = folderId;
      renderTabs();
      bindInlineEditors();
    });
    row.querySelector('[data-smart-folder-toggle]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      smartFolderPreviewId = '';
      await send({
        type: 'UPDATE_SMART_FOLDER',
        folderId,
        folder: { collapsed: !folder.collapsed },
      });
      await loadSmartFolders();
    });
    row.querySelector('[data-smart-folder-menu]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      smartFolderCtxMenu(event, folderId);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      smartFolderCtxMenu(event, folderId);
    });
  });
}

function bindFolderPreviewInteractions() {
  document.querySelectorAll('.folder-preview-item').forEach((button) => {
    button.onclick = async () => {
      const tabId = Number(button.dataset.previewTabId);
      if (!tabId) return;
      await send({ type: 'ACTIVATE_TAB', tabId });
      handleSingleSelection(tabId);
    };
  });
}

function showUrl(url) {
  if (!settings.urlHover || !url) return;

  if (!urlBarEl) {
    urlBarEl = document.createElement('div');
    urlBarEl.id = 'url-bar';
    document.body.appendChild(urlBarEl);
  }

  urlBarEl.textContent = url;
  urlBarEl.style.display = 'block';
}

function hideUrl() {
  if (urlBarEl) urlBarEl.style.display = 'none';
}

function showCtx(event, items) {
  const menu = $('ctx-menu');
  const list = $('ctx-list');

  list.innerHTML = '';
  items.forEach((item) => {
    if (!item) {
      const separator = document.createElement('li');
      separator.className = 'ctx-sep';
      list.appendChild(separator);
      return;
    }

    const entry = document.createElement('li');
    entry.className = `ctx-item${item.danger ? ' danger' : ''}`;
    entry.innerHTML = `${item.ico || ''}<span>${esc(item.label)}</span>`;
    entry.onclick = async () => {
      hideCtx();
      await item.fn();
    };
    list.appendChild(entry);
  });

  menu.classList.remove('hidden');
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight - 8) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
}

function hideCtx() {
  $('ctx-menu').classList.add('hidden');
}

function tabCtxMenu(event, tabId) {
  const tab = getTab(tabId);
  if (!tab) return;

  const node = getNode(tabId);
  const hasKids = !!node?.children?.length;
  const inGroup = tab.groupId != null && tab.groupId !== -1;
  const inFolder = !!node?.folderId;
  const selectedTabIds = selectedTabIdsFor(tabId);
  const subtreeIds = tabSubtreeIds(tabId).filter((id) => !!getTab(id));
  const folderEligibleIds = selectedTabIds.filter((selectedId) => !getTab(selectedId)?.pinned);
  const folderLabel = folderEligibleIds.length > 1 ? 'Create folder from selection' : 'Create folder';

  showCtx(event, [
    { label: 'Rename display title', ico: icoEdit(), fn: () => startEditTab(tabId) },
    hasAlias(tabId) ? { label: 'Reset display title', ico: icoReset(), fn: () => send({ type: 'RENAME_TAB', windowId: winId, tabId, title: '' }) } : null,
    { label: tab.pinned ? 'Unpin' : 'Pin', ico: icoPin(), fn: () => send({ type: 'PIN_TAB', tabId, pinned: !tab.pinned }) },
    { label: 'Duplicate', ico: icoDup(), fn: () => send({ type: 'DUPLICATE_TAB', tabId }) },
    { label: 'New child tab', ico: icoPlus(), fn: () => send({ type: 'NEW_TAB', windowId: winId, openerTabId: tabId }) },
    null,
    { label: folderLabel, ico: icoFolderPlus(), fn: () => promptCreateFolder(folderEligibleIds) },
    inFolder ? { label: 'Remove from folder', ico: icoUngroup(), fn: () => send({ type: 'REMOVE_TABS_FROM_FOLDER', windowId: winId, tabIds: selectedTabIds }) } : null,
    inGroup
      ? { label: 'Remove from group', ico: icoUngroup(), fn: () => send({ type: 'UNGROUP_TAB_TREE', windowId: winId, tabId }) }
      : {
          label: 'Group tree',
          ico: icoGroup(),
          fn: async () => {
            const result = await send({ type: 'CREATE_TAB_GROUP', tabId, title: displayTitle(tab), color: 'blue' });
            if (result?.groupId != null) startEditGroup(result.groupId);
          },
        },
    null,
    { label: 'Bookmark tab', ico: icoBookmark(), fn: () => send({ type: 'BOOKMARK_TAB', tabId }) },
    { label: 'Add to favorites', ico: icoBookmark(), fn: async () => { await send({ type: 'SAVE_FAVORITE_FROM_TAB', tabId }); await loadFavorites(); } },
    { label: 'Copy url', ico: icoCopy(), fn: () => navigator.clipboard.writeText(tab.url || '') },
    hasKids ? { label: 'Bookmark branch', ico: icoBookmark(), fn: () => send({ type: 'BATCH_BOOKMARK_TABS', windowId: winId, tabIds: subtreeIds }) } : null,
    null,
    tab.pinned ? { label: 'Set current page as pinned home', ico: icoReset(), fn: () => send({ type: 'SET_PINNED_HOME', windowId: winId, tabId }) } : null,
    tab.pinned && node?.pinnedHomeUrl ? { label: 'Reset to pinned home', ico: icoReset(), fn: () => send({ type: 'RESET_PINNED_HOME', windowId: winId, tabId }) } : null,
    tab.pinned ? { label: 'Open pinned home as tab', ico: icoDup(), fn: () => send({ type: 'OPEN_PINNED_AS_REGULAR', windowId: winId, tabId }) } : null,
    { label: tab.mutedInfo?.muted ? 'Unmute' : 'Mute', ico: icoAudio(), fn: () => send({ type: 'MUTE_TAB', tabId, muted: !tab.mutedInfo?.muted }) },
    !tab.discarded && !tab.active ? { label: 'Discard', ico: icoDiscard(), fn: () => send({ type: 'DISCARD_TAB', tabId }) } : null,
    { label: 'Reload', ico: icoReload(), fn: () => send({ type: 'RELOAD_TAB', tabId }) },
    { label: 'Move to new window', ico: icoWin(), fn: () => send({ type: 'MOVE_TO_NEW_WINDOW', tabId }) },
    hasKids ? { label: 'Move branch to new window', ico: icoWin(), fn: () => send({ type: 'BATCH_MOVE_TO_NEW_WINDOW', windowId: winId, tabIds: subtreeIds }) } : null,
    null,
    { label: 'Archive tab', ico: icoLayers(), fn: async () => { await send({ type: 'ARCHIVE_TABS', windowId: winId, tabIds: [tabId] }); await loadArchivedTabs(); } },
    { label: 'Close others', ico: icoLayers(), fn: () => send({ type: 'CLOSE_OTHER_TABS', windowId: winId, tabId }) },
    { label: 'Close tab', ico: icoX(), fn: () => send({ type: 'CLOSE_TAB', tabId }), danger: true },
    hasKids ? { label: 'Close branch', ico: icoBranch(), fn: () => send({ type: 'CLOSE_TAB_TREE', windowId: winId, tabId }), danger: true } : null,
  ].filter(Boolean));
}

function folderCtxMenu(event, folderId) {
  const folder = getFolder(folderId);
  if (!folder) return;

  showCtx(event, [
    { label: 'Rename folder', ico: icoEdit(), fn: () => startEditFolder(folderId) },
    {
      label: folder.collapsed ? 'Expand folder' : 'Collapse folder',
      ico: icoChevron(),
      fn: () => send({ type: 'SET_FOLDER_COLLAPSED', windowId: winId, folderId, collapsed: !folder.collapsed }),
    },
    { label: 'Convert to tab group', ico: icoGroup(), fn: () => convertFolderToGroup(folderId) },
    null,
    { label: 'Remove folder keep tabs', ico: icoUngroup(), fn: () => send({ type: 'REMOVE_FOLDER', windowId: winId, folderId }) },
    { label: 'Close folder tabs', ico: icoX(), fn: () => send({ type: 'CLOSE_FOLDER', windowId: winId, folderId }), danger: true },
  ]);
}

function smartFolderCtxMenu(event, folderId) {
  const folder = smartFolders.find((item) => item.id === folderId);
  if (!folder) return;

  showCtx(event, [
    { label: 'Rename live folder', ico: icoEdit(), fn: () => { editingSmartFolderId = folderId; renderTabs(); bindInlineEditors(); } },
    {
      label: folder.collapsed ? 'Expand live folder' : 'Collapse live folder',
      ico: icoChevron(),
      fn: async () => {
        await send({ type: 'UPDATE_SMART_FOLDER', folderId, folder: { collapsed: !folder.collapsed } });
        await loadSmartFolders();
      },
    },
    query.trim() ? {
      label: 'Update to current search',
      ico: icoReload(),
      fn: async () => {
        await send({ type: 'UPDATE_SMART_FOLDER', folderId, folder: { query, title: folder.title } });
        await loadSmartFolders();
      },
    } : null,
    null,
    { label: 'Delete live folder', ico: icoX(), fn: async () => { await send({ type: 'DELETE_SMART_FOLDER', folderId }); await loadSmartFolders(); }, danger: true },
  ].filter(Boolean));
}

function groupCtxMenu(event, groupId) {
  const group = groups[groupId];
  if (!group) return;
  const tabIds = groupTabIds(groupId);

  showCtx(event, [
    { label: 'Rename group', ico: icoEdit(), fn: () => startEditGroup(groupId) },
    {
      label: group.collapsed ? 'Expand group' : 'Collapse group',
      ico: icoChevron(),
      fn: () => send({ type: 'TOGGLE_GROUP_COLLAPSED', groupId, collapsed: !group.collapsed }),
    },
    { label: 'Convert to folder', ico: icoFolderPlus(), fn: () => convertGroupToFolder(groupId) },
    { label: 'Create folder copy', ico: icoFolderPlus(), fn: () => promptCreateFolder(tabIds) },
    { label: 'Bookmark group', ico: icoBookmark(), fn: () => send({ type: 'BATCH_BOOKMARK_TABS', windowId: winId, tabIds }) },
    { label: 'Move group to new window', ico: icoWin(), fn: () => send({ type: 'BATCH_MOVE_TO_NEW_WINDOW', windowId: winId, tabIds }) },
    null,
    ...['blue', 'green', 'yellow', 'red', 'purple', 'cyan', 'orange', 'pink', 'grey'].map((color) => ({
      label: `Color: ${color}`,
      ico: icoSwatch(color),
      fn: () => send({ type: 'SET_GROUP_COLOR', groupId, color }),
    })),
    null,
    { label: 'Ungroup all', ico: icoUngroup(), fn: () => send({ type: 'UNGROUP_ALL', windowId: winId, groupId }) },
    { label: 'Close group', ico: icoX(), fn: () => send({ type: 'CLOSE_GROUP', windowId: winId, groupId }), danger: true },
  ]);
}

function bmCtxMenu(event, node) {
  showCtx(
    event,
    node.url
      ? [
          { label: 'Open', ico: icoOpen(), fn: () => send({ type: 'OPEN_BOOKMARK', url: node.url, newTab: false }) },
          { label: 'Open in new tab', ico: icoPlus(), fn: () => send({ type: 'OPEN_BOOKMARK', url: node.url, newTab: true }) },
          null,
          { label: 'Delete', ico: icoX(), fn: async () => { if (!confirm(`Delete bookmark "${node.title || 'Untitled'}"?`)) return; await send({ type: 'REMOVE_BOOKMARK', id: node.id, confirmed: true }); await loadBookmarks(); }, danger: true },
        ]
      : [
          { label: 'Delete folder', ico: icoX(), fn: async () => { if (!confirm(`Delete bookmark folder "${node.title || 'Folder'}" and all of its contents?`)) return; await send({ type: 'REMOVE_BOOKMARK_TREE', id: node.id, confirmed: true }); await loadBookmarks(); }, danger: true },
        ],
  );
}

function historyCtxMenu(event, url) {
  showCtx(event, [
    { label: 'Open', ico: icoOpen(), fn: () => send({ type: 'OPEN_BOOKMARK', url, newTab: false }) },
    { label: 'Open in new tab', ico: icoPlus(), fn: () => send({ type: 'OPEN_BOOKMARK', url, newTab: true }) },
    { label: 'Copy url', ico: icoCopy(), fn: () => navigator.clipboard.writeText(url) },
  ]);
}

function closedCtxMenu(event, sessionId, url) {
  showCtx(
    event,
    [
      { label: 'Restore', ico: icoOpen(), fn: () => send({ type: 'RESTORE_SESSION', sessionId }) },
      url ? { label: 'Copy url', ico: icoCopy(), fn: () => navigator.clipboard.writeText(url) } : null,
    ].filter(Boolean),
  );
}

function snapshotCtxMenu(event, snapshotId) {
  const snapshot = savedSnapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return;

  showCtx(event, [
    { label: 'Restore in new window', ico: icoOpen(), fn: () => send({ type: 'RESTORE_SNAPSHOT', snapshotId }) },
    {
      label: 'Rename snapshot',
      ico: icoEdit(),
      fn: () => startEditSnapshot(snapshotId),
    },
    { label: 'Delete snapshot', ico: icoX(), fn: async () => { await send({ type: 'DELETE_SNAPSHOT', snapshotId }); await loadSavedSnapshots(); }, danger: true },
  ]);
}

function favoriteCtxMenu(event, favoriteId) {
  const favorite = favorites.find((item) => item.id === favoriteId);
  if (!favorite) return;

  showCtx(event, [
    { label: 'Open', ico: icoOpen(), fn: () => send({ type: 'OPEN_FAVORITE', windowId: winId, favoriteId }) },
    { label: 'Copy url', ico: icoCopy(), fn: () => navigator.clipboard.writeText(favorite.url || '') },
    null,
    { label: 'Remove favorite', ico: icoX(), fn: async () => { await send({ type: 'DELETE_FAVORITE', favoriteId }); await loadFavorites(); }, danger: true },
  ]);
}

function archivedCtxMenu(event, archiveId) {
  const archived = archivedTabs.find((item) => item.id === archiveId);
  if (!archived) return;

  showCtx(event, [
    { label: 'Restore tab', ico: icoOpen(), fn: async () => { const result = await send({ type: 'RESTORE_ARCHIVED_TAB', archiveId, windowId: winId }); if (result?.snapshot) applySnapshot(result.snapshot); await loadArchivedTabs(); } },
    { label: 'Copy url', ico: icoCopy(), fn: () => navigator.clipboard.writeText(archived.url || '') },
    null,
    { label: 'Delete archive entry', ico: icoX(), fn: async () => { await send({ type: 'DELETE_ARCHIVED_TAB', archiveId }); await loadArchivedTabs(); }, danger: true },
  ]);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
  const currentSettings = stored[SETTINGS_KEY];
  const rawSettings = stored[SETTINGS_KEY]
    ? stored[SETTINGS_KEY]
    : stored[LEGACY_SETTINGS_KEY]
      ? {
          ...stored[LEGACY_SETTINGS_KEY],
          theme:
            stored[LEGACY_SETTINGS_KEY].theme === 'light' || stored[LEGACY_SETTINGS_KEY].theme === 'system'
              ? stored[LEGACY_SETTINGS_KEY].theme
              : 'system',
        }
      : {};
  const nextSettings = normalizeSettings(rawSettings);

  settings = nextSettings;
  panelQueries = { ...nextSettings.panelQueries };
  panel = nextSettings.lastPanel || 'tabs';
  query = panelQueries[panel] || '';
  applySettings();

  if (!currentSettings || JSON.stringify(currentSettings) !== JSON.stringify(nextSettings)) {
    chrome.storage.local.set({
      [SETTINGS_KEY]: {
        ...settings,
        panelQueries,
        lastPanel: panel,
      },
    });
  }
}

function scheduleSaveSettings() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    chrome.storage.local.set({
      [SETTINGS_KEY]: {
        ...settings,
        panelQueries,
        lastPanel: panel,
      },
    });
  }, 120);
}

function applyCustomCss() {
  if (!customStyleEl) {
    customStyleEl = document.createElement('style');
    customStyleEl.id = 'custom-style';
    document.head.appendChild(customStyleEl);
  }

  customStyleEl.textContent = settings.customCss || '';
}

function applySettings() {
  const resolvedTheme =
    settings.theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : settings.theme;

  document.documentElement.setAttribute('data-theme', resolvedTheme);
  document.documentElement.style.colorScheme = resolvedTheme;
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--accent-2', `${settings.accent}22`);
  const effectiveIndent =
    window.innerWidth <= 420
      ? Math.max(10, settings.indent - 4)
      : window.innerWidth <= 560
        ? Math.max(10, settings.indent - 2)
        : settings.indent;
  document.documentElement.style.setProperty('--indent', `${effectiveIndent}px`);
  document.body.classList.toggle('compact', !!settings.compact);
  document.body.classList.toggle('show-tree-lines', !!settings.treeLines);

  $('setting-theme').value = settings.theme;
  $('setting-indent').value = String(settings.indent);
  $('indent-val').textContent = `${settings.indent}px`;
  $('setting-favicons').checked = !!settings.favicons;
  $('setting-compact').checked = !!settings.compact;
  $('setting-tree-lines').checked = !!settings.treeLines;
  $('setting-groups').checked = !!settings.groups;
  $('setting-tab-meta').checked = !!settings.tabMeta;
  $('setting-custom-css').value = settings.customCss || '';
  if ($('history-range')) $('history-range').value = String(settings.historyRange || DEFAULT_SETTINGS.historyRange);

  document.querySelectorAll('.swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color === settings.accent);
  });

  applyCustomCss();
}

function icoSwatch(colorName) {
  const color = GROUP_COLORS[colorName] || settings.accent;
  return `<svg viewBox="0 0 13 13" fill="currentColor" stroke="none"><circle cx="6.5" cy="6.5" r="4" style="color:${color}"/></svg>`;
}

function focusedEntity() {
  if (!focusedKey) return null;
  const separatorIndex = focusedKey.indexOf(':');
  const kind = separatorIndex === -1 ? focusedKey : focusedKey.slice(0, separatorIndex);
  const rawId = separatorIndex === -1 ? '' : focusedKey.slice(separatorIndex + 1);
  if (!kind || rawId == null) return null;
  return {
    kind,
    id: kind === 'tab' || kind === 'group' ? Number(rawId) : rawId,
  };
}

function moveFocusBy(delta) {
  const rows = visibleFocusableRows();
  if (!rows.length) return;

  const currentIndex = rows.findIndex((row) => row.dataset.focusKey === focusedKey);
  const nextIndex = currentIndex === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
  const nextRow = rows[nextIndex];
  if (!nextRow) return;
  setFocusedKey(nextRow.dataset.focusKey, { focus: true });
}

function toggleFocusedContainer(direction = 'toggle') {
  const focused = focusedEntity();
  if (!focused) return;

  if (focused.kind === 'smart-folder') {
    const folder = smartFolders.find((item) => item.id === focused.id);
    if (!folder) return;
    const collapsed = direction === 'expand' ? false : direction === 'collapse' ? true : !folder.collapsed;
    send({
      type: 'UPDATE_SMART_FOLDER',
      folderId: focused.id,
      folder: { collapsed },
    }).then(loadSmartFolders);
    return;
  }

  if (focused.kind === 'folder') {
    const folder = getFolder(focused.id);
    if (!folder) return;
    const collapsed = direction === 'expand' ? false : direction === 'collapse' ? true : !folder.collapsed;
    send({ type: 'SET_FOLDER_COLLAPSED', windowId: winId, folderId: focused.id, collapsed });
    return;
  }

  if (focused.kind === 'group') {
    const group = groups[focused.id];
    if (!group) return;
    const collapsed = direction === 'expand' ? false : direction === 'collapse' ? true : !group.collapsed;
    send({ type: 'TOGGLE_GROUP_COLLAPSED', groupId: focused.id, collapsed });
    return;
  }

  if (focused.kind === 'tab') {
    const node = getNode(focused.id);
    if (!node?.children?.length) return;
    const collapsed = direction === 'expand' ? false : direction === 'collapse' ? true : !node.collapsed;
    send({ type: 'SET_COLLAPSED', windowId: winId, tabId: focused.id, collapsed });
  }
}

function activateFocusedItem() {
  const focused = focusedEntity();
  if (!focused) return;

  if (focused.kind === 'tab') {
    handleSingleSelection(focused.id);
    return;
  }

  if (focused.kind === 'bookmark') {
    const currentFolder = currentBmFolder();
    const node = (currentFolder?.children || []).find((item) => item.id === focused.id);
    if (!node) return;
    if (node.url) send({ type: 'OPEN_BOOKMARK', url: node.url, newTab: false });
    else {
      bmPath.push(node);
      renderBookmarks();
    }
    return;
  }

  if (focused.kind === 'snapshot') {
    send({ type: 'RESTORE_SNAPSHOT', snapshotId: focused.id });
    return;
  }

  if (focused.kind === 'archived') {
    send({ type: 'RESTORE_ARCHIVED_TAB', archiveId: focused.id, windowId: winId }).then(async (result) => {
      if (result?.snapshot) applySnapshot(result.snapshot);
      await loadArchivedTabs();
    });
    return;
  }

  if (focused.kind === 'closed') {
    send({ type: 'RESTORE_SESSION', sessionId: focused.id });
    return;
  }

  if (focused.kind === 'history') {
    send({ type: 'OPEN_BOOKMARK', url: focused.id, newTab: false });
    return;
  }

  toggleFocusedContainer();
}

function startFocusedRename() {
  const focused = focusedEntity();
  if (!focused) return;

  if (focused.kind === 'tab') startEditTab(focused.id);
  if (focused.kind === 'folder') startEditFolder(focused.id);
  if (focused.kind === 'group') startEditGroup(focused.id);
  if (focused.kind === 'snapshot') startEditSnapshot(focused.id);
  if (focused.kind === 'smart-folder') {
    clearEditingState();
    editingSmartFolderId = focused.id;
    renderTabs();
    bindInlineEditors();
  }
}

function onMessage(message) {
  if (!message) return;

  switch (message.type) {
    case 'STATE_SYNC':
      if (winId == null || message.snapshot.windowId === winId) applySnapshot(message.snapshot);
      break;

    case 'TAB_UPDATED': {
      if (message.tab.windowId !== winId) return;
      const index = tabs.findIndex((tab) => tab.id === message.tabId);
      if (index !== -1) {
        tabs[index] = { ...tabs[index], ...message.tab };
        if (panel === 'tabs') renderTabs();
      }
      break;
    }

    case 'TAB_ACTIVATED':
      if (message.windowId !== winId) return;
      activeId = message.tabId;
      if (!highlightedIds.has(activeId) || highlightedIds.size <= 1) {
        highlightedIds = new Set([activeId]);
      }
      reconcileSelectionState();
      renderSummary();
      updateSelectionBar();
      if (panel === 'tabs') renderTabs();
      break;

    case 'TABS_HIGHLIGHTED':
      if (message.windowId !== winId) return;
      highlightedIds = new Set(message.tabIds);
      reconcileSelectionState();
      renderSummary();
      updateSelectionBar();
      if (panel === 'tabs') renderTabs();
      break;

    default:
      break;
  }
}

async function init() {
  const currentWindow = await chrome.windows.getCurrent();
  const snapshot = await send({ type: 'GET_INIT_STATE', windowId: currentWindow.id });
  applySnapshot(snapshot);
}

async function boot() {
  await loadSettings();
  await init();
  await loadFavorites();
  await loadSmartFolders();
  await loadArchivedTabs();
  await loadSavedSnapshots();
  await loadUndoState();

  $('pins-list').setAttribute('role', 'tree');
  $('tabs-list').setAttribute('role', 'tree');
  $('tabs-list').addEventListener('scroll', scheduleRenderTabs, { passive: true });
  $('search-input').value = query;
  $('search-clear').classList.toggle('show', !!query);
  $('history-range').value = String(settings.historyRange || DEFAULT_SETTINGS.historyRange);

  document.querySelectorAll('.nav-btn[data-panel]').forEach((button) => {
    button.onclick = () => switchPanel(button.dataset.panel);
  });

  $('btn-new-tab-nav').onclick = () => send({ type: 'NEW_TAB', windowId: winId });
  $('btn-settings').onclick = settingsPanel.show;
  settingsPanel.bindCloseButton($('btn-settings-close'));
  $('btn-settings-close').onclick = settingsPanel.hide;

  $('btn-collapse-all').onclick = () => send({ type: 'SET_ALL_COLLAPSED', windowId: winId, collapsed: true });
  $('btn-expand-all').onclick = () => send({ type: 'SET_ALL_COLLAPSED', windowId: winId, collapsed: false });
  $('btn-restore-last').onclick = () => send({ type: 'RESTORE_LAST_CLOSED' });
  $('btn-refresh-closed').onclick = async () => {
    const result = await send({ type: 'GET_RECENTLY_CLOSED', maxResults: 12 });
    recentlyClosed = result.items || [];
    renderRecentlyClosed();
    updateNavCounts();
  };
  $('btn-save-snapshot').onclick = async () => {
    await send({ type: 'SAVE_SNAPSHOT', windowId: winId });
    await loadSavedSnapshots();
    showToast('Snapshot saved');
  };
  $('btn-save-smart-folder').onclick = async () => {
    if (!query.trim()) return;
    const result = await send({
      type: 'CREATE_SMART_FOLDER',
      folder: {
        title: query,
        query,
      },
    });
    if (result?.smartFolder?.id) {
      await loadSmartFolders();
      showToast('Live folder saved');
    }
  };
  $('btn-undo').onclick = async () => {
    const result = await send({ type: 'UNDO_LAST_ACTION', windowId: winId });
    if (result?.snapshot) {
      showToast('Last change restored');
    }
    await loadUndoState();
  };
  $('btn-favorite-current').onclick = async () => {
    if (activeId == null) return;
    const result = await send({ type: 'SAVE_FAVORITE_FROM_TAB', tabId: activeId });
    if (result?.favorite) {
      await loadFavorites();
      showToast('Added to favorites');
    }
  };

  $('btn-selection-folder').onclick = () => promptCreateFolder(currentSelectedTabIds());
  $('btn-selection-unfolder').onclick = () => send({ type: 'REMOVE_TABS_FROM_FOLDER', windowId: winId, tabIds: currentSelectedTabIds() });
  $('btn-selection-group').onclick = async () => {
    const result = await send({ type: 'BATCH_GROUP_TABS', windowId: winId, tabIds: currentSelectedTabIds(), title: 'Selected tabs', color: 'blue' });
    if (result?.groupId != null) startEditGroup(result.groupId);
  };
  $('btn-selection-ungroup').onclick = () => send({ type: 'BATCH_UNGROUP_TABS', windowId: winId, tabIds: currentSelectedTabIds() });
  $('btn-selection-pin').onclick = () => {
    const selectedTabs = currentSelectedTabIds().map(getTab).filter(Boolean);
    const nextPinned = !selectedTabs.every((tab) => tab.pinned);
    send({ type: 'BATCH_PIN_TABS', windowId: winId, tabIds: currentSelectedTabIds(), pinned: nextPinned });
  };
  $('btn-selection-mute').onclick = () => {
    const selectedTabs = currentSelectedTabIds().map(getTab).filter(Boolean);
    const nextMuted = !selectedTabs.every((tab) => tab.mutedInfo?.muted);
    send({ type: 'BATCH_MUTE_TABS', windowId: winId, tabIds: currentSelectedTabIds(), muted: nextMuted });
  };
  $('btn-selection-bookmark').onclick = () => send({ type: 'BATCH_BOOKMARK_TABS', windowId: winId, tabIds: currentSelectedTabIds() });
  $('btn-selection-window').onclick = () => send({ type: 'BATCH_MOVE_TO_NEW_WINDOW', windowId: winId, tabIds: currentSelectedTabIds() });
  $('btn-selection-close').onclick = () => send({ type: 'BATCH_CLOSE_TABS', windowId: winId, tabIds: currentSelectedTabIds() });

  $('btn-bookmarks-up').onclick = () => {
    if (!bmPath.length) return;
    bmPath = bmPath.slice(0, -1);
    renderBookmarks();
  };
  $('btn-bookmarks-home').onclick = () => {
    bmPath = [];
    renderBookmarks();
  };
  $('btn-bookmark-current').onclick = () => {
    if (activeId != null) send({ type: 'BOOKMARK_TAB', tabId: activeId });
  };

  $('search-input').oninput = (event) => {
    setCurrentQuery(event.target.value);
    settings.panelQueries = panelQueries;
    scheduleSaveSettings();

    if (panel === 'tabs') renderTabs();
    if (panel === 'bookmarks') renderBookmarks();
    if (panel === 'history') {
      renderSnapshots();
      renderRecentlyClosed();
      loadHistory();
    }
  };

  $('search-input').onkeydown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusSearchResults(1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusSearchResults(-1);
    }
    if (event.key === 'Enter' && panel === 'tabs' && visibleTabSequence.length) {
      event.preventDefault();
      handleSingleSelection(visibleTabSequence[0]);
    }
  };

  $('search-clear').onclick = () => {
    clearSearch();
  };

  $('pins-head').onclick = (event) => {
    if (event.target.closest('[data-id]')) return;
    settings.pinnedCollapsed = !settings.pinnedCollapsed;
    renderTabs();
    scheduleSaveSettings();
  };

  $('pins-head').onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    settings.pinnedCollapsed = !settings.pinnedCollapsed;
    renderTabs();
    scheduleSaveSettings();
  };

  $('history-range').onchange = () => {
    settings.historyRange = Number($('history-range').value);
    scheduleSaveSettings();
    loadHistory();
  };

  $('setting-theme').onchange = (event) => {
    settings.theme = event.target.value;
    applySettings();
    scheduleSaveSettings();
  };

  $('setting-indent').oninput = (event) => {
    settings.indent = Number(event.target.value);
    applySettings();
    renderTabs();
    scheduleSaveSettings();
  };

  $('setting-favicons').onchange = (event) => {
    settings.favicons = event.target.checked;
    renderTabs();
    scheduleSaveSettings();
  };

  $('setting-compact').onchange = (event) => {
    settings.compact = event.target.checked;
    applySettings();
    renderTabs();
    scheduleSaveSettings();
  };

  $('setting-tree-lines').onchange = (event) => {
    settings.treeLines = event.target.checked;
    applySettings();
    renderTabs();
    scheduleSaveSettings();
  };

  $('setting-groups').onchange = (event) => {
    settings.groups = event.target.checked;
    renderTabs();
    scheduleSaveSettings();
  };

  $('setting-tab-meta').onchange = (event) => {
    settings.tabMeta = event.target.checked;
    renderTabs();
    scheduleSaveSettings();
  };

  $('setting-custom-css').oninput = (event) => {
    settings.customCss = event.target.value;
    applyCustomCss();
    scheduleSaveSettings();
  };

  $('btn-export-data').onclick = async () => {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      settings: {
        ...settings,
        panelQueries,
        lastPanel: panel,
      },
      ...(await send({ type: 'EXPORT_SIDEBERY_DATA' })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sidebery-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Sidebar data exported');
  };

  $('btn-import-data').onclick = () => $('import-file').click();
  $('import-file').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.settings) {
        settings = normalizeSettings(payload.settings);
        panelQueries = settings.panelQueries;
        panel = settings.lastPanel || panel;
        query = panelQueries[panel] || '';
        applySettings();
        scheduleSaveSettings();
      }
      await send({ type: 'IMPORT_SIDEBERY_DATA', payload });
      await loadSavedSnapshots();
      await loadFavorites();
      await loadSmartFolders();
      await loadArchivedTabs();
      updateNavCounts();
      switchPanel(panel);
      showToast('Sidebar data imported');
    } catch {
      showToast('Import failed');
    } finally {
      event.target.value = '';
    }
  };

  document.querySelectorAll('.swatch').forEach((swatch) => {
    swatch.onclick = () => {
      settings.accent = swatch.dataset.color;
      applySettings();
      scheduleSaveSettings();
    };
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') applySettings();
  });

  window.addEventListener('resize', () => {
    applySettings();
    if (panel === 'tabs') renderTabs();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#ctx-menu')) hideCtx();
  });

  document.addEventListener('keydown', (event) => {
    const activeElement = document.activeElement;
    const isEditing = activeElement?.classList?.contains('inline-edit');
    const isTypingContext =
      isEditing
      || activeElement === $('search-input')
      || activeElement?.tagName === 'TEXTAREA'
      || activeElement?.tagName === 'SELECT';

    if (event.key === 'Escape') {
      if (!$('ctx-menu')?.classList.contains('hidden')) {
        event.preventDefault();
        hideCtx();
        return;
      }

      if ($('settings-panel') && !$('settings-panel').classList.contains('hidden')) {
        event.preventDefault();
        settingsPanel.hide();
        return;
      }

      if ($('search-input').value || query) {
        event.preventDefault();
        clearSearch();
        $('search-input').focus();
        return;
      }

      if (clearSelectionToActive()) {
        event.preventDefault();
        return;
      }

      hideCtx();
    }

    if (event.key === '/' && document.activeElement !== $('search-input') && !isTypingContext) {
      event.preventDefault();
      $('search-input').focus();
      $('search-input').select();
    }

    if (isTypingContext) return;

    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.shiftKey) {
      const focused = focusedEntity();
      if (focused?.kind === 'tab') {
        const currentIndex = visibleTabSequence.indexOf(focused.id);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextId = visibleTabSequence[Math.min(visibleTabSequence.length - 1, Math.max(0, currentIndex + delta))];
        if (nextId != null && nextId !== focused.id) {
          event.preventDefault();
          handleRangeSelection(nextId);
          setFocusedKey(focusKeyFor('tab', nextId), { focus: true });
          return;
        }
      }
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocusBy(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocusBy(-1);
      return;
    }

    if (panel === 'bookmarks' && event.key === 'ArrowLeft' && bmPath.length) {
      event.preventDefault();
      bmPath = bmPath.slice(0, -1);
      renderBookmarks();
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      toggleFocusedContainer('expand');
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      toggleFocusedContainer('collapse');
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      activateFocusedItem();
      return;
    }

    if (event.key === ' ') {
      const focused = focusedEntity();
      if (focused?.kind === 'tab') {
        event.preventDefault();
        if (event.shiftKey) handleRangeSelection(focused.id);
        else handleToggleSelection(focused.id);
        return;
      }
    }

    if (event.key === 'F2') {
      event.preventDefault();
      startFocusedRename();
    }
  });

  chrome.runtime.onMessage.addListener(onMessage);
  switchPanel(panel);
}

boot();
