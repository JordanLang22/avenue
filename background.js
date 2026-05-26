import {
  collectBlockTabIds,
  insertionIndexForMove,
  normalizeTabIdList,
} from './background/command-helpers.js';
import {
  createArchivedTab,
  createFavorite,
  createSavedSnapshot,
  createSavedState,
  createSmartFolder,
  createUndoEntry,
  getArchivedTabs,
  getFavorites,
  getSavedSnapshots,
  getSmartFolders,
  getUndoEntries,
  setArchivedTabs,
  setFavorites,
  setSavedSnapshots,
  setSmartFolders,
  setUndoEntries,
} from './background/storage-helpers.js';

const STORAGE_KEY = 'sb_window_state_v2';

const windowsState = new Map();
const snapshotTimers = new Map();
const windowRefreshTimers = new Map();
const lastActiveTabByWindow = new Map();

let stateLoaded = false;
let saveTimer = null;

function fireAndForget(promise, label) {
  promise.catch((error) => {
    console.error(`[Avenue] ${label}`, error);
  });
}

function createNode(seed = {}) {
  return {
    parentId: seed.parentId ?? null,
    collapsed: !!seed.collapsed,
    manualParent: !!seed.manualParent,
    customTitle: typeof seed.customTitle === 'string' ? seed.customTitle : '',
    pinnedHomeUrl: typeof seed.pinnedHomeUrl === 'string' ? seed.pinnedHomeUrl : '',
    pinnedHomeTitle: typeof seed.pinnedHomeTitle === 'string' ? seed.pinnedHomeTitle : '',
    lastSeenAt: Number.isFinite(seed.lastSeenAt) ? seed.lastSeenAt : Date.now(),
    folderId: seed.folderId ?? null,
    children: Array.isArray(seed.children) ? [...seed.children] : [],
  };
}

function createFolder(seed = {}) {
  return {
    id: seed.id ?? `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof seed.title === 'string' && seed.title.trim() ? seed.title.trim() : 'Folder',
    collapsed: !!seed.collapsed,
    tabIds: Array.isArray(seed.tabIds) ? [...seed.tabIds] : [],
    sortIndex: Number.isFinite(seed.sortIndex) ? seed.sortIndex : Number.MAX_SAFE_INTEGER,
  };
}

function createWindowState() {
  return {
    nodes: new Map(),
    groups: new Map(),
    folders: new Map(),
  };
}

function ensureWindowState(windowId) {
  if (!windowsState.has(windowId)) {
    windowsState.set(windowId, createWindowState());
  }
  return windowsState.get(windowId);
}

function serializeState() {
  const windows = {};

  for (const [windowId, win] of windowsState.entries()) {
    const nodes = {};
    const groups = {};
    const folders = {};

    for (const [tabId, node] of win.nodes.entries()) {
      nodes[tabId] = {
        parentId: node.parentId ?? null,
        collapsed: !!node.collapsed,
        manualParent: !!node.manualParent,
        customTitle: node.customTitle || '',
        pinnedHomeUrl: node.pinnedHomeUrl || '',
        pinnedHomeTitle: node.pinnedHomeTitle || '',
        lastSeenAt: Number.isFinite(node.lastSeenAt) ? node.lastSeenAt : Date.now(),
        folderId: node.folderId ?? null,
      };
    }

    for (const [groupId, group] of win.groups.entries()) {
      groups[groupId] = { ...group };
    }

    for (const [folderId, folder] of win.folders.entries()) {
      folders[folderId] = {
        id: folder.id,
        title: folder.title,
        collapsed: !!folder.collapsed,
        tabIds: [...folder.tabIds],
        sortIndex: folder.sortIndex,
      };
    }

    windows[windowId] = {
      nodes,
      groups,
      folders,
    };
  }

  return windows;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fireAndForget(chrome.storage.local.set({ [STORAGE_KEY]: serializeState() }), 'save state');
  }, 100);
}

function hostForUrl(url = '') {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function ensureStateLoaded() {
  if (stateLoaded) return;

  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved && typeof saved === 'object') {
    for (const [windowId, rawWindow] of Object.entries(saved)) {
      const win = createWindowState();

      for (const [tabId, rawNode] of Object.entries(rawWindow.nodes ?? {})) {
        win.nodes.set(Number(tabId), createNode(rawNode));
      }

      for (const [groupId, rawGroup] of Object.entries(rawWindow.groups ?? {})) {
        win.groups.set(Number(groupId), { ...rawGroup, id: Number(groupId) });
      }

      for (const [folderId, rawFolder] of Object.entries(rawWindow.folders ?? {})) {
        win.folders.set(folderId, createFolder({ ...rawFolder, id: folderId }));
      }

      windowsState.set(Number(windowId), win);
    }
  }

  stateLoaded = true;
}

function serializeNodes(nodes) {
  const out = {};
  for (const [tabId, node] of nodes.entries()) {
    out[tabId] = {
      parentId: node.parentId ?? null,
      children: [...node.children],
      collapsed: !!node.collapsed,
      manualParent: !!node.manualParent,
      customTitle: node.customTitle || '',
      pinnedHomeUrl: node.pinnedHomeUrl || '',
      pinnedHomeTitle: node.pinnedHomeTitle || '',
      lastSeenAt: Number.isFinite(node.lastSeenAt) ? node.lastSeenAt : Date.now(),
      folderId: node.folderId ?? null,
    };
  }
  return out;
}

function serializeGroups(groups) {
  const out = {};
  for (const [groupId, group] of groups.entries()) {
    out[groupId] = { ...group };
  }
  return out;
}

function serializeFolders(folders) {
  const out = {};
  for (const [folderId, folder] of folders.entries()) {
    out[folderId] = {
      id: folder.id,
      title: folder.title,
      collapsed: !!folder.collapsed,
      tabIds: [...folder.tabIds],
      sortIndex: folder.sortIndex,
    };
  }
  return out;
}

function cloneTabForSnapshot(tab) {
  return {
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || tab.url || 'Tab',
    pinned: !!tab.pinned,
    active: !!tab.active,
    groupId: tab.groupId ?? chrome.tabGroups.TAB_GROUP_ID_NONE,
  };
}

function snapshotTitleFromEntries(entries, explicitTitle = '') {
  if (explicitTitle?.trim()) return explicitTitle.trim();
  if (!entries.length) return 'Saved tabs';
  if (entries.length === 1) return entries[0].title || 'Saved tab';
  return `${entries[0].title || 'Tabs'} +${entries.length - 1}`;
}

function sanitizeSnapshotUrl(url = '') {
  if (!url) return '';
  return /^(chrome|chrome-extension|edge|about|devtools):/i.test(url) ? '' : url;
}

function remapParentKeys(entries) {
  const keys = new Set(entries.map((entry) => entry.key));
  return entries.map((entry) => ({
    ...entry,
    parentKey: entry.parentKey && keys.has(entry.parentKey) ? entry.parentKey : null,
  }));
}

function uniqueSortedIds(tabIds, tabsById, { allowPinned = true } = {}) {
  return normalizeTabIdList(tabIds, [...tabsById.values()], { allowPinned });
}

function getDescendants(nodes, tabId) {
  const node = nodes.get(tabId);
  if (!node) return [];

  const out = [];
  for (const childId of node.children) {
    out.push(childId, ...getDescendants(nodes, childId));
  }
  return out;
}

function getSubtreeIds(nodes, rootId) {
  return [rootId, ...getDescendants(nodes, rootId)];
}

function removeFromParent(nodes, tabId) {
  const node = nodes.get(tabId);
  if (!node || node.parentId == null) return;

  const parent = nodes.get(node.parentId);
  if (parent) {
    parent.children = parent.children.filter((childId) => childId !== tabId);
  }
}

function isValidParent(tab, parentTab) {
  if (!tab || !parentTab) return false;
  if (tab.id === parentTab.id) return false;
  if (tab.windowId !== parentTab.windowId) return false;
  if (tab.index <= parentTab.index) return false;
  if (!!tab.pinned !== !!parentTab.pinned) return false;
  if ((tab.groupId ?? -1) !== (parentTab.groupId ?? -1)) return false;
  return true;
}

function wouldCreateCycle(nodes, childId, parentId) {
  let currentId = parentId;

  while (currentId != null) {
    if (currentId === childId) return true;
    currentId = nodes.get(currentId)?.parentId ?? null;
  }

  return false;
}

function nodeFromFallback(tab, existingNode, tabsById) {
  if (existingNode.manualParent) return existingNode.parentId;
  const openerTab = tab.openerTabId != null ? tabsById.get(tab.openerTabId) : null;
  return isValidParent(tab, openerTab) ? openerTab.id : null;
}

function syncChildrenLists(win, orderedTabs) {
  for (const node of win.nodes.values()) {
    node.children = [];
  }

  for (const tab of orderedTabs) {
    const node = win.nodes.get(tab.id);
    if (!node || node.parentId == null) continue;

    const parent = win.nodes.get(node.parentId);
    if (parent) parent.children.push(tab.id);
  }
}

function normalizeFolderMembership(win, tabsById) {
  const tabs = [...tabsById.values()].sort((a, b) => a.index - b.index);
  const liveIds = new Set(tabs.map((tab) => tab.id));

  for (const folder of win.folders.values()) {
    folder.tabIds = folder.tabIds.filter((tabId) => liveIds.has(tabId));
    folder.sortIndex = folder.tabIds.length
      ? Math.min(...folder.tabIds.map((tabId) => tabsById.get(tabId)?.index ?? Number.MAX_SAFE_INTEGER))
      : folder.sortIndex;
  }

  for (const node of win.nodes.values()) {
    if (node.folderId && !win.folders.has(node.folderId)) {
      node.folderId = null;
    }
  }

  const folderMembership = new Map();
  for (const [tabId, node] of win.nodes.entries()) {
    if (!node.folderId) continue;
    if (!win.folders.has(node.folderId)) {
      node.folderId = null;
      continue;
    }
    if (!folderMembership.has(node.folderId)) folderMembership.set(node.folderId, []);
    folderMembership.get(node.folderId).push(tabId);
  }

  for (const [folderId, folder] of [...win.folders.entries()]) {
    const memberIds = (folderMembership.get(folderId) || [])
      .filter((tabId) => liveIds.has(tabId))
      .sort((a, b) => (tabsById.get(a)?.index ?? 0) - (tabsById.get(b)?.index ?? 0));

    folder.tabIds = memberIds;
    folder.sortIndex = memberIds.length
      ? Math.min(...memberIds.map((tabId) => tabsById.get(tabId)?.index ?? Number.MAX_SAFE_INTEGER))
      : folder.sortIndex;

    if (!folder.title?.trim()) folder.title = 'Folder';
    if (!memberIds.length) {
      win.folders.delete(folderId);
    }
  }
}

async function queryGroups(windowId) {
  try {
    const groups = await chrome.tabGroups.query({ windowId });
    return new Map(
      groups.map((group) => [
        group.id,
        {
          id: group.id,
          title: group.title || '',
          color: group.color,
          collapsed: !!group.collapsed,
          windowId: group.windowId,
        },
      ]),
    );
  } catch {
    return new Map();
  }
}

async function syncWindow(windowId) {
  await ensureStateLoaded();

  const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const win = ensureWindowState(windowId);

  for (const tabId of [...win.nodes.keys()]) {
    if (!tabsById.has(tabId)) win.nodes.delete(tabId);
  }

  for (const tab of tabs) {
    const existingNode = createNode(win.nodes.get(tab.id));
    let parentId = existingNode.manualParent ? existingNode.parentId : nodeFromFallback(tab, existingNode, tabsById);
    const savedParentTab = tabsById.get(parentId);

    if (!isValidParent(tab, savedParentTab) || wouldCreateCycle(win.nodes, tab.id, parentId)) {
      parentId = nodeFromFallback(tab, existingNode, tabsById);
      if (parentId == null || !isValidParent(tab, tabsById.get(parentId))) {
        parentId = null;
        existingNode.manualParent = false;
      }
    }

    win.nodes.set(tab.id, {
      ...existingNode,
      pinnedHomeUrl:
        existingNode.pinnedHomeUrl
        || (tab.pinned ? sanitizeSnapshotUrl(tab.url || tab.pendingUrl || '') : ''),
      pinnedHomeTitle: existingNode.pinnedHomeTitle || (tab.pinned ? tab.title || tab.url || 'Pinned tab' : ''),
      lastSeenAt: tab.active ? Date.now() : existingNode.lastSeenAt,
      parentId,
      children: [],
    });
  }

  syncChildrenLists(win, tabs);
  normalizeFolderMembership(win, tabsById);
  win.groups = await queryGroups(windowId);
  const activeTab = tabs.find((tab) => tab.active);
  if (activeTab) {
    lastActiveTabByWindow.set(windowId, activeTab.id);
    const activeNode = win.nodes.get(activeTab.id);
    if (activeNode) activeNode.lastSeenAt = Date.now();
  }
  scheduleSave();

  return {
    windowId,
    tabs,
    tree: serializeNodes(win.nodes),
    groups: serializeGroups(win.groups),
    folders: serializeFolders(win.folders),
  };
}

async function getRecentlyClosed(maxResults = 12) {
  try {
    const items = await chrome.sessions.getRecentlyClosed({ maxResults });
    return items
      .map((item) => {
        if (item.tab?.sessionId) {
          return {
            sessionId: item.tab.sessionId,
            kind: 'tab',
            title: item.tab.title || item.tab.url || 'Closed tab',
            url: item.tab.url || '',
            favIconUrl: item.tab.favIconUrl || '',
          };
        }

        if (item.window?.sessionId) {
          const tabs = item.window.tabs || [];
          const firstUrl = tabs.find((tab) => tab.url)?.url || '';
          return {
            sessionId: item.window.sessionId,
            kind: 'window',
            title: tabs.length > 1 ? `Closed window (${tabs.length} tabs)` : 'Closed window',
            url: firstUrl,
            favIconUrl: tabs[0]?.favIconUrl || '',
            count: tabs.length,
          };
        }

        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function buildSnapshot(windowId) {
  const snapshot = await syncWindow(windowId);
  return {
    ...snapshot,
    recentlyClosed: await getRecentlyClosed(),
  };
}

function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Ignore if the panel isn't open.
  });
}

function requireConfirmed(message, action) {
  if (!message.confirmed) {
    throw new Error(`${action} requires explicit confirmation.`);
  }
}

function scheduleSnapshot(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;

  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.set(
    windowId,
    setTimeout(() => {
      fireAndForget(
        (async () => {
          const snapshot = await buildSnapshot(windowId);
          broadcastMessage({ type: 'STATE_SYNC', snapshot });
        })(),
        `broadcast snapshot for window ${windowId}`,
      );
    }, 60),
  );
}

function scheduleWindowRefresh(windowId, label = 'window refresh') {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;

  clearTimeout(windowRefreshTimers.get(windowId));
  windowRefreshTimers.set(
    windowId,
    setTimeout(() => {
      windowRefreshTimers.delete(windowId);
      fireAndForget(syncWindow(windowId).then(() => scheduleSnapshot(windowId)), label);
    }, 40),
  );
}

function updateFolderMembership(win, tabIds, nextFolderId) {
  const movingIds = new Set(tabIds);

  for (const folder of win.folders.values()) {
    folder.tabIds = folder.tabIds.filter((tabId) => !movingIds.has(tabId));
  }

  if (nextFolderId && win.folders.has(nextFolderId)) {
    const folder = win.folders.get(nextFolderId);
    folder.tabIds.push(...tabIds);
    folder.tabIds = [...new Set(folder.tabIds)];
  }

  for (const tabId of tabIds) {
    const node = win.nodes.get(tabId);
    if (node) node.folderId = nextFolderId ?? null;
  }
}

function cleanupFolderMembership(win) {
  for (const [folderId, folder] of [...win.folders.entries()]) {
    folder.tabIds = [...new Set(folder.tabIds)];
    if (!folder.tabIds.length) win.folders.delete(folderId);
  }
}

function getOrderedFolderTabIds(win, tabsById, folderId) {
  const folder = win.folders.get(folderId);
  if (!folder) return [];

  return uniqueSortedIds(folder.tabIds, tabsById, { allowPinned: false });
}

function getSubtreeEndIndex(nodes, tabsById, tabId) {
  const ids = getSubtreeIds(nodes, tabId);
  return Math.max(...ids.map((id) => tabsById.get(id)?.index ?? -1));
}

async function moveTabInTree({ windowId, tabId, targetId, position }) {
  const snapshot = await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const tabs = snapshot.tabs;
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const movingTab = tabsById.get(tabId);

  if (!movingTab) return;

  const movingIds = getSubtreeIds(win.nodes, tabId)
    .filter((id) => tabsById.has(id))
    .sort((a, b) => tabsById.get(a).index - tabsById.get(b).index);

  const movingSet = new Set(movingIds);
  if (targetId != null && movingSet.has(targetId)) return;

  let targetTab = targetId != null ? tabsById.get(targetId) : null;
  if (targetTab && !!targetTab.pinned !== !!movingTab.pinned) {
    targetTab = null;
    position = movingTab.pinned ? 'before' : 'after';
  }

  let parentId = null;
  let rawIndex = tabs.length;
  let nextFolderId = null;

  if (targetTab) {
    nextFolderId = win.nodes.get(targetId)?.folderId ?? null;
    if (position === 'inside') {
      parentId = targetId;
      rawIndex = getSubtreeEndIndex(win.nodes, tabsById, targetId) + 1;
    } else {
      parentId = win.nodes.get(targetId)?.parentId ?? null;
      rawIndex = position === 'before' ? targetTab.index : getSubtreeEndIndex(win.nodes, tabsById, targetId) + 1;
    }
  } else if (movingTab.pinned) {
    rawIndex = 0;
  }

  const movedBeforeTarget = tabs.filter((tab) => movingSet.has(tab.id) && tab.index < rawIndex).length;
  let insertIndex = rawIndex - movedBeforeTarget;

  const remainingTabs = tabs.filter((tab) => !movingSet.has(tab.id));
  const remainingPinned = remainingTabs.filter((tab) => tab.pinned).length;

  if (movingTab.pinned) {
    insertIndex = Math.min(insertIndex, remainingPinned);
  } else {
    insertIndex = Math.max(insertIndex, remainingPinned);
  }

  const movingNode = win.nodes.get(tabId);
  if (!movingNode) return;

  removeFromParent(win.nodes, tabId);
  movingNode.parentId = parentId;
  movingNode.manualParent = parentId != null;

  if (parentId != null && wouldCreateCycle(win.nodes, tabId, parentId)) {
    movingNode.parentId = null;
    movingNode.manualParent = false;
  }

  updateFolderMembership(win, movingIds, nextFolderId);
  cleanupFolderMembership(win);

  await chrome.tabs.move(movingIds, { windowId, index: insertIndex });

  if (targetTab) {
    if ((targetTab.groupId ?? -1) === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabs.ungroup(movingIds).catch(() => {});
    } else {
      await chrome.tabs.group({ groupId: targetTab.groupId, tabIds: movingIds }).catch(() => {});
    }
  }

  scheduleSave();
  scheduleSnapshot(windowId);
}

async function setAllCollapsed(windowId, collapsed) {
  await syncWindow(windowId);
  const win = ensureWindowState(windowId);

  for (const node of win.nodes.values()) {
    if (node.children.length) node.collapsed = !!collapsed;
  }

  for (const folder of win.folders.values()) {
    folder.collapsed = !!collapsed;
  }

  scheduleSave();
  scheduleSnapshot(windowId);
}

async function setCollapsed(windowId, tabId, collapsed) {
  await syncWindow(windowId);
  const node = ensureWindowState(windowId).nodes.get(tabId);
  if (!node) return;

  node.collapsed = !!collapsed;
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function setFolderCollapsed(windowId, folderId, collapsed) {
  await syncWindow(windowId);
  const folder = ensureWindowState(windowId).folders.get(folderId);
  if (!folder) return;

  folder.collapsed = !!collapsed;
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function closeTabTree(windowId, tabId) {
  await syncWindow(windowId);
  const ids = getSubtreeIds(ensureWindowState(windowId).nodes, tabId);
  await chrome.tabs.remove(ids);
}

async function closeOtherTabs(windowId, tabId) {
  const snapshot = await syncWindow(windowId);
  const keep = new Set(getSubtreeIds(ensureWindowState(windowId).nodes, tabId));
  const ids = snapshot.tabs.filter((tab) => !keep.has(tab.id)).map((tab) => tab.id);
  if (ids.length) await chrome.tabs.remove(ids);
}

async function groupTabTree(tabId, title, color = 'blue') {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.windowId) return;

  await syncWindow(tab.windowId);
  const ids = getSubtreeIds(ensureWindowState(tab.windowId).nodes, tabId);
  const groupId = await chrome.tabs.group({ tabIds: ids });
  await chrome.tabGroups.update(groupId, { title: title || '', color });
  scheduleSnapshot(tab.windowId);
  return groupId;
}

async function ungroupTabTree(windowId, tabId) {
  await syncWindow(windowId);
  const ids = getSubtreeIds(ensureWindowState(windowId).nodes, tabId);
  await chrome.tabs.ungroup(ids);
  scheduleSnapshot(windowId);
}

async function closeGroup(windowId, groupId) {
  const tabs = await chrome.tabs.query({ windowId, groupId });
  if (tabs.length) await chrome.tabs.remove(tabs.map((tab) => tab.id));
}

async function ungroupAll(windowId, groupId) {
  const tabs = await chrome.tabs.query({ windowId, groupId });
  if (tabs.length) await chrome.tabs.ungroup(tabs.map((tab) => tab.id));
  scheduleSnapshot(windowId);
}

async function renameGroup(groupId, title) {
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return;
  await chrome.tabGroups.update(groupId, { title: title?.trim() || '' });
  scheduleSnapshot(group.windowId);
}

async function setGroupColor(groupId, color) {
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return;
  await chrome.tabGroups.update(groupId, { color: color || 'blue' });
  scheduleSnapshot(group.windowId);
}

async function bookmarkTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return;

  const tree = await chrome.bookmarks.getTree();
  const barId = tree[0]?.children?.[0]?.id;
  if (!barId) return;

  await chrome.bookmarks.create({
    parentId: barId,
    title: tab.title || tab.url,
    url: tab.url,
  });
}

async function renameTab(windowId, tabId, title) {
  await syncWindow(windowId);
  const node = ensureWindowState(windowId).nodes.get(tabId);
  if (!node) return;

  node.customTitle = title?.trim() || '';
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function createFolderFromTabs(windowId, rawTabIds, title) {
  const snapshot = await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const tabsById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  const tabIds = [...new Set(rawTabIds)]
    .filter((tabId) => tabsById.has(tabId) && !tabsById.get(tabId).pinned)
    .sort((a, b) => tabsById.get(a).index - tabsById.get(b).index);

  if (!tabIds.length) return null;

  const folder = createFolder({
    title: title?.trim() || 'Folder',
    tabIds,
    collapsed: false,
    sortIndex: Math.min(...tabIds.map((tabId) => tabsById.get(tabId)?.index ?? Number.MAX_SAFE_INTEGER)),
  });

  const selectedSet = new Set(tabIds);
  updateFolderMembership(win, tabIds, folder.id);

  for (const tabId of tabIds) {
    const node = win.nodes.get(tabId);
    if (!node) continue;
    if (node.parentId != null && !selectedSet.has(node.parentId)) {
      removeFromParent(win.nodes, tabId);
      node.parentId = null;
      node.manualParent = false;
    }
  }

  syncChildrenLists(win, snapshot.tabs);
  win.folders.set(folder.id, folder);
  cleanupFolderMembership(win);
  scheduleSave();
  scheduleSnapshot(windowId);
  return {
    id: folder.id,
    title: folder.title,
  };
}

async function removeTabsFromFolder(windowId, rawTabIds) {
  const snapshot = await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const tabIds = [...new Set(rawTabIds)].filter((tabId) => win.nodes.has(tabId));

  updateFolderMembership(win, tabIds, null);
  cleanupFolderMembership(win);
  syncChildrenLists(win, snapshot.tabs);
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function renameFolder(windowId, folderId, title) {
  await syncWindow(windowId);
  const folder = ensureWindowState(windowId).folders.get(folderId);
  if (!folder) return;

  folder.title = title?.trim() || 'Folder';
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function removeFolder(windowId, folderId) {
  await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const folder = win.folders.get(folderId);
  if (!folder) return;

  updateFolderMembership(win, folder.tabIds, null);
  win.folders.delete(folderId);
  cleanupFolderMembership(win);
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function closeFolder(windowId, folderId) {
  await syncWindow(windowId);
  const folder = ensureWindowState(windowId).folders.get(folderId);
  if (!folder?.tabIds.length) return;

  await chrome.tabs.remove(folder.tabIds);
}

async function moveTabsToFolder(windowId, rawTabIds, folderId) {
  const snapshot = await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const folder = win.folders.get(folderId);
  if (!folder) return;

  const tabsById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById, { allowPinned: false });
  if (!tabIds.length) return;

  const existingMemberIds = getOrderedFolderTabIds(win, tabsById, folderId).filter((tabId) => !tabIds.includes(tabId));
  const movingBeforeTarget = existingMemberIds.length
    ? tabIds.filter((tabId) => tabsById.get(tabId).index < (tabsById.get(existingMemberIds.at(-1))?.index ?? 0) + 1).length
    : tabIds.filter((tabId) => tabsById.get(tabId).index < (folder.sortIndex ?? snapshot.tabs.length)).length;

  const rawIndex = existingMemberIds.length
    ? (tabsById.get(existingMemberIds.at(-1))?.index ?? 0) + 1
    : folder.sortIndex ?? snapshot.tabs.length;

  const remainingPinned = snapshot.tabs.filter((tab) => !tabIds.includes(tab.id) && tab.pinned).length;
  const insertIndex = Math.max(rawIndex - movingBeforeTarget, remainingPinned);

  const movingSet = new Set(tabIds);
  updateFolderMembership(win, tabIds, folderId);
  for (const tabId of tabIds) {
    const node = win.nodes.get(tabId);
    if (!node) continue;
    if (node.parentId != null && !movingSet.has(node.parentId)) {
      removeFromParent(win.nodes, tabId);
      node.parentId = null;
      node.manualParent = false;
    }
  }
  cleanupFolderMembership(win);
  syncChildrenLists(win, snapshot.tabs);
  await chrome.tabs.move(tabIds, { windowId, index: insertIndex });

  scheduleSave();
  scheduleSnapshot(windowId);
}

async function moveFolderBlock(windowId, folderId, targetFolderId = null, position = 'after') {
  const snapshot = await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const tabsById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  const movingIds = getOrderedFolderTabIds(win, tabsById, folderId);
  if (!movingIds.length) return;

  const targetIds = targetFolderId ? getOrderedFolderTabIds(win, tabsById, targetFolderId) : [];
  if (targetFolderId && !targetIds.length) return;

  const movingSet = new Set(movingIds);
  const remainingPinned = snapshot.tabs.filter((tab) => !movingSet.has(tab.id) && tab.pinned).length;
  const plannedIndex = targetIds.length
    ? insertionIndexForMove(snapshot.tabs, movingIds, targetIds, position)
    : snapshot.tabs.length;
  const insertIndex = Math.max(plannedIndex, remainingPinned);

  await chrome.tabs.move(movingIds, { windowId, index: insertIndex });

  const folder = win.folders.get(folderId);
  if (folder) folder.sortIndex = insertIndex;

  scheduleSave();
  scheduleSnapshot(windowId);
}

async function moveGroupBlock(windowId, groupId, targetGroupId = null, position = 'after') {
  const allTabs = await chrome.tabs.query({ windowId });
  const movingIds = collectBlockTabIds(allTabs, 'group', groupId);
  if (!movingIds.length) return;

  const movingSet = new Set(movingIds);
  const remainingPinned = allTabs.filter((tab) => !movingSet.has(tab.id) && tab.pinned).length;
  const targetIds = targetGroupId != null ? collectBlockTabIds(allTabs, 'group', targetGroupId) : [];
  const plannedIndex = targetIds.length
    ? insertionIndexForMove(allTabs, movingIds, targetIds, position)
    : allTabs.length;
  const insertIndex = Math.max(plannedIndex, remainingPinned);

  await chrome.tabs.move(movingIds, { windowId, index: insertIndex });
  scheduleSnapshot(windowId);
}

async function batchCloseTabs(windowId, rawTabIds) {
  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById);
  if (!tabIds.length) return;

  await chrome.tabs.remove(tabIds);
}

async function batchPinTabs(windowId, rawTabIds, pinned) {
  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById);
  for (const tabId of tabIds) {
    await chrome.tabs.update(tabId, { pinned: !!pinned });
  }
  scheduleSnapshot(windowId);
}

async function batchMuteTabs(windowId, rawTabIds, muted) {
  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById);
  for (const tabId of tabIds) {
    await chrome.tabs.update(tabId, { muted: !!muted });
  }
  scheduleSnapshot(windowId);
}

async function batchBookmarkTabs(windowId, rawTabIds) {
  const tabs = await chrome.tabs.query({ windowId });
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById);
  if (!tabIds.length) return;

  const tree = await chrome.bookmarks.getTree();
  const barId = tree[0]?.children?.[0]?.id;
  if (!barId) return;

  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    const url = sanitizeSnapshotUrl(tab?.url || tab?.pendingUrl || '');
    if (!url) continue;
    await chrome.bookmarks.create({
      parentId: barId,
      title: tab.title || url,
      url,
    });
  }
}

async function batchMoveToNewWindow(windowId, rawTabIds) {
  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById);
  if (!tabIds.length) return;

  const [firstTabId, ...restTabIds] = tabIds;
  const newWindow = await chrome.windows.create({ tabId: firstTabId });
  if (restTabIds.length) {
    await chrome.tabs.move(restTabIds, { windowId: newWindow.id, index: -1 });
  }

  scheduleSnapshot(windowId);
  scheduleSnapshot(newWindow.id);
}

async function batchGroupTabs(windowId, rawTabIds, title = '', color = 'blue') {
  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById, { allowPinned: false });
  if (!tabIds.length) return;

  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, { title: title?.trim() || 'Selected tabs', color });
  scheduleSnapshot(windowId);
  return groupId;
}

async function moveTabsToGroup(windowId, rawTabIds, groupId) {
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group || group.windowId !== windowId) return;

  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById, { allowPinned: false })
    .filter((tabId) => tabsById.get(tabId)?.groupId !== groupId);
  if (!tabIds.length) return;

  await chrome.tabs.group({ groupId, tabIds });
  scheduleSnapshot(windowId);
}

async function batchUngroupTabs(windowId, rawTabIds) {
  const tabsById = new Map((await chrome.tabs.query({ windowId })).map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById);
  if (!tabIds.length) return;

  await chrome.tabs.ungroup(tabIds).catch(() => {});
  scheduleSnapshot(windowId);
}

async function captureWindowState(windowId, title = '') {
  const snapshot = await syncWindow(windowId);
  const orderedTabs = [...snapshot.tabs].sort((a, b) => a.index - b.index);
  const tree = snapshot.tree || {};
  const groups = snapshot.groups || {};
  const folders = snapshot.folders || {};

  const entries = orderedTabs
    .map((tab) => {
      const nextUrl = sanitizeSnapshotUrl(tab.url || tab.pendingUrl || '');
      if (!nextUrl) return null;

      return {
        key: String(tab.id),
        ...cloneTabForSnapshot(tab),
        url: nextUrl,
        customTitle: tree[tab.id]?.customTitle || '',
        pinnedHomeUrl: tree[tab.id]?.pinnedHomeUrl || '',
        pinnedHomeTitle: tree[tab.id]?.pinnedHomeTitle || '',
        parentKey: tree[tab.id]?.parentId != null ? String(tree[tab.id].parentId) : null,
        collapsed: !!tree[tab.id]?.collapsed,
        folderKey: tree[tab.id]?.folderId || null,
        groupKey: tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? String(tab.groupId) : null,
      };
    })
    .filter(Boolean);

  if (!entries.length) return null;

  const validKeys = new Set(entries.map((entry) => entry.key));
  return {
    title: snapshotTitleFromEntries(entries, title),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entryCount: entries.length,
    entries: remapParentKeys(entries),
    groups: Object.values(groups)
      .map((group) => ({
        key: String(group.id),
        title: group.title || '',
        color: group.color || 'blue',
        collapsed: !!group.collapsed,
        memberKeys: entries
          .filter((entry) => entry.groupKey === String(group.id))
          .map((entry) => entry.key),
      }))
      .filter((group) => group.memberKeys.length),
    folders: Object.values(folders)
      .map((folder) => ({
        key: folder.id,
        title: folder.title || 'Folder',
        collapsed: !!folder.collapsed,
        sortIndex: folder.sortIndex,
        memberKeys: folder.tabIds.map(String).filter((key) => validKeys.has(key)),
      }))
      .filter((folder) => folder.memberKeys.length),
  };
}

async function mergeSavedStateIntoWindow(savedState, entries, targetWindowId) {
  const snapshot = await syncWindow(targetWindowId);
  const currentTabs = [...snapshot.tabs].sort((a, b) => a.index - b.index);
  const currentTabsByOldKey = new Map(currentTabs.map((tab) => [String(tab.id), tab]));
  const tabIdByKey = new Map();
  const restoredIds = new Set();
  let insertIndex = currentTabs.length;

  for (const entry of entries) {
    let tab = currentTabsByOldKey.get(String(entry.key));
    if (!tab) {
      tab = await chrome.tabs.create({
        windowId: targetWindowId,
        url: entry.url,
        active: false,
        index: insertIndex,
      });
      insertIndex += 1;
    }

    if (tab?.id) {
      tabIdByKey.set(entry.key, tab.id);
      restoredIds.add(tab.id);
      await chrome.tabs.update(tab.id, {
        pinned: !!entry.pinned,
      }).catch(() => {});
    }
  }

  for (const group of savedState.groups || []) {
    const groupTabIds = (group.memberKeys || []).map((key) => tabIdByKey.get(key)).filter(Boolean);
    if (!groupTabIds.length) continue;

    const groupId = await chrome.tabs.group({ tabIds: groupTabIds }).catch(() => null);
    if (groupId != null) {
      await chrome.tabGroups.update(groupId, {
        title: group.title || '',
        color: group.color || 'blue',
        collapsed: !!group.collapsed,
      }).catch(() => {});
    }
  }

  const restoredTabs = (await chrome.tabs.query({ windowId: targetWindowId })).sort((a, b) => a.index - b.index);
  const restoredTabsById = new Map(restoredTabs.map((tab) => [tab.id, tab]));
  const folderIdMap = new Map();
  const win = ensureWindowState(targetWindowId);

  for (const tabId of restoredIds) {
    removeFromParent(win.nodes, tabId);
  }

  for (const folder of savedState.folders || []) {
    const restoredFolderId = typeof folder.key === 'string' && folder.key ? folder.key : createFolder().id;
    folderIdMap.set(folder.key, restoredFolderId);
    const tabIds = (folder.memberKeys || []).map((key) => tabIdByKey.get(key)).filter(Boolean);

    win.folders.set(
      restoredFolderId,
      createFolder({
        id: restoredFolderId,
        title: folder.title || 'Folder',
        collapsed: !!folder.collapsed,
        tabIds,
        sortIndex: Number.isFinite(folder.sortIndex) ? folder.sortIndex : Number.MAX_SAFE_INTEGER,
      }),
    );
  }

  for (const entry of entries) {
    const tabId = tabIdByKey.get(entry.key);
    if (!tabId) continue;

    const parentTabId = entry.parentKey ? tabIdByKey.get(entry.parentKey) ?? null : null;
    win.nodes.set(
      tabId,
      createNode({
        parentId: parentTabId,
        collapsed: !!entry.collapsed,
        manualParent: !!parentTabId,
        customTitle: entry.customTitle || '',
        pinnedHomeUrl: entry.pinnedHomeUrl || '',
        pinnedHomeTitle: entry.pinnedHomeTitle || '',
        folderId: entry.folderKey ? folderIdMap.get(entry.folderKey) ?? null : null,
        lastSeenAt: Date.now(),
      }),
    );
  }

  syncChildrenLists(win, restoredTabs);
  normalizeFolderMembership(win, restoredTabsById);
  win.groups = await queryGroups(targetWindowId);

  const activeEntry = entries.find((entry) => entry.active) || entries[0];
  if (activeEntry) {
    const activeTabId = tabIdByKey.get(activeEntry.key);
    if (activeTabId) {
      await chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
      lastActiveTabByWindow.set(targetWindowId, activeTabId);
    }
  }

  scheduleSave();
  scheduleSnapshot(targetWindowId);
  return buildSnapshot(targetWindowId);
}

async function applySavedStateToWindow(savedState, { windowId = null, replaceWindow = true } = {}) {
  const entries = (savedState?.entries || [])
    .filter((entry) => sanitizeSnapshotUrl(entry.url))
    .map((entry) => ({
      ...entry,
      url: sanitizeSnapshotUrl(entry.url),
    }));

  if (!entries.length) return null;

  if (windowId != null && !replaceWindow) {
    return mergeSavedStateIntoWindow(savedState, entries, windowId);
  }

  const [firstEntry, ...restEntries] = entries;
  let targetWindowId = windowId;
  let seedTab = null;

  if (targetWindowId == null) {
    const newWindow = await chrome.windows.create({ url: firstEntry.url });
    targetWindowId = newWindow.id;
    [seedTab] = await chrome.tabs.query({ windowId: targetWindowId });
  } else {
    const currentTabs = (await chrome.tabs.query({ windowId: targetWindowId })).sort((a, b) => a.index - b.index);
    if (currentTabs.length > 1) {
      await chrome.tabs.remove(currentTabs.slice(1).map((tab) => tab.id));
    }

    seedTab = currentTabs[0] || null;
    if (!seedTab) {
      seedTab = await chrome.tabs.create({
        windowId: targetWindowId,
        url: firstEntry.url,
        active: false,
        index: 0,
      });
    } else {
      await chrome.tabs.update(seedTab.id, {
        url: firstEntry.url,
        active: false,
        pinned: false,
      }).catch(() => {});
    }
  }

  if (!seedTab) return null;

  const createdTabs = [await chrome.tabs.get(seedTab.id).catch(() => seedTab)];
  for (const entry of restEntries) {
    const tab = await chrome.tabs.create({
      windowId: targetWindowId,
      url: entry.url,
      active: false,
      index: createdTabs.length,
    });
    createdTabs.push(tab);
  }

  const orderedEntries = [firstEntry, ...restEntries];
  const tabIdByKey = new Map(
    orderedEntries
      .map((entry, index) => [entry.key, createdTabs[index]?.id])
      .filter(([, tabId]) => !!tabId),
  );

  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const tabId = createdTabs[index]?.id;
    if (!tabId) continue;

    await chrome.tabs.update(tabId, {
      pinned: !!entry.pinned,
      active: false,
    }).catch(() => {});
  }

  for (const group of savedState.groups || []) {
    const groupTabIds = (group.memberKeys || []).map((key) => tabIdByKey.get(key)).filter(Boolean);
    if (!groupTabIds.length) continue;

    const groupId = await chrome.tabs.group({ tabIds: groupTabIds }).catch(() => null);
    if (groupId != null) {
      await chrome.tabGroups.update(groupId, {
        title: group.title || '',
        color: group.color || 'blue',
        collapsed: !!group.collapsed,
      }).catch(() => {});
    }
  }

  const restoredTabs = (await chrome.tabs.query({ windowId: targetWindowId })).sort((a, b) => a.index - b.index);
  const restoredTabsById = new Map(restoredTabs.map((tab) => [tab.id, tab]));
  const folderIdMap = new Map();
  const win = createWindowState();
  windowsState.set(targetWindowId, win);

  for (const folder of savedState.folders || []) {
    const restoredFolderId = createFolder().id;
    folderIdMap.set(folder.key, restoredFolderId);
    const tabIds = (folder.memberKeys || []).map((key) => tabIdByKey.get(key)).filter(Boolean);

    win.folders.set(
      restoredFolderId,
      createFolder({
        id: restoredFolderId,
        title: folder.title || 'Folder',
        collapsed: !!folder.collapsed,
        tabIds,
        sortIndex: Number.isFinite(folder.sortIndex) ? folder.sortIndex : Number.MAX_SAFE_INTEGER,
      }),
    );
  }

  for (const entry of orderedEntries) {
    const tabId = tabIdByKey.get(entry.key);
    if (!tabId) continue;

    const parentTabId = entry.parentKey ? tabIdByKey.get(entry.parentKey) ?? null : null;
    win.nodes.set(
      tabId,
      createNode({
        parentId: parentTabId,
        collapsed: !!entry.collapsed,
        manualParent: !!parentTabId,
        customTitle: entry.customTitle || '',
        pinnedHomeUrl: entry.pinnedHomeUrl || '',
        pinnedHomeTitle: entry.pinnedHomeTitle || '',
        folderId: entry.folderKey ? folderIdMap.get(entry.folderKey) ?? null : null,
      }),
    );
  }

  syncChildrenLists(win, restoredTabs);
  normalizeFolderMembership(win, restoredTabsById);
  win.groups = await queryGroups(targetWindowId);

  const activeEntry = orderedEntries.find((entry) => entry.active) || orderedEntries[0];
  if (activeEntry) {
    const activeTabId = tabIdByKey.get(activeEntry.key);
    if (activeTabId) {
      await chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
      lastActiveTabByWindow.set(targetWindowId, activeTabId);
    }
  }

  scheduleSave();
  scheduleSnapshot(targetWindowId);
  return buildSnapshot(targetWindowId);
}

async function getUndoStatus(windowId) {
  const [latest] = await getUndoEntries(windowId);
  return {
    canUndo: !!latest?.snapshot,
    label: latest?.label || '',
    createdAt: latest?.createdAt || null,
  };
}

async function pushUndoSnapshot(windowId, label) {
  const captured = await captureWindowState(windowId, label || 'Recovered tabs');
  if (!captured) return null;

  const entries = await getUndoEntries(windowId);
  entries.unshift(
    createUndoEntry({
      label: label || 'Last change',
      createdAt: Date.now(),
      snapshot: createSavedState({
        ...captured,
        title: captured.title || label || 'Recovered tabs',
      }),
    }),
  );
  await setUndoEntries(windowId, entries);
  return entries[0];
}

async function undoLastAction(windowId) {
  const entries = await getUndoEntries(windowId);
  const [latest, ...rest] = entries;
  if (!latest?.snapshot) return null;

  await setUndoEntries(windowId, rest);
  return applySavedStateToWindow(latest.snapshot, { windowId, replaceWindow: false });
}

async function saveCurrentSnapshot(windowId, title = '') {
  const captured = await captureWindowState(windowId, title);
  if (!captured) return null;

  const saved = createSavedSnapshot(captured);
  const snapshots = await getSavedSnapshots();
  snapshots.unshift(saved);
  await setSavedSnapshots(snapshots);
  return saved;
}

async function renameSavedSnapshot(snapshotId, title) {
  const snapshots = await getSavedSnapshots();
  const nextSnapshots = snapshots.map((snapshot) =>
    snapshot.id === snapshotId ? { ...snapshot, title: title?.trim() || snapshot.title || 'Saved tabs' } : snapshot,
  );
  await setSavedSnapshots(nextSnapshots);
}

async function deleteSavedSnapshot(snapshotId) {
  const snapshots = await getSavedSnapshots();
  await setSavedSnapshots(snapshots.filter((snapshot) => snapshot.id !== snapshotId));
}

async function restoreSavedSnapshot(snapshotId) {
  const snapshots = await getSavedSnapshots();
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return null;

  return applySavedStateToWindow(snapshot);
}

async function saveFavoriteFromTab(tabId, title = '') {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = sanitizeSnapshotUrl(tab?.url || tab?.pendingUrl || '');
  if (!tab || !url) return null;

  const favorites = await getFavorites();
  const existing = favorites.find((favorite) => favorite.url === url);
  const favorite = createFavorite({
    ...existing,
    title: title?.trim() || existing?.title || tab.title || hostForUrl(url) || 'Favorite',
    url,
    updatedAt: Date.now(),
  });
  const nextFavorites = existing
    ? favorites.map((item) => (item.id === existing.id ? favorite : item))
    : [favorite, ...favorites];
  await setFavorites(nextFavorites);
  return favorite;
}

async function deleteFavorite(favoriteId) {
  const favorites = await getFavorites();
  await setFavorites(favorites.filter((favorite) => favorite.id !== favoriteId));
}

async function openFavorite(windowId, favoriteId) {
  const favorites = await getFavorites();
  const favorite = favorites.find((item) => item.id === favoriteId);
  if (!favorite?.url) return null;

  const snapshot = await syncWindow(windowId);
  const existing = snapshot.tabs.find((tab) => sanitizeSnapshotUrl(tab.url || tab.pendingUrl || '') === favorite.url);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    scheduleSave();
    scheduleSnapshot(windowId);
    return buildSnapshot(windowId);
  }

  const created = await chrome.tabs.create({ windowId, url: favorite.url, active: true });
  const win = ensureWindowState(windowId);
  const node = win.nodes.get(created.id) || createNode();
  node.lastSeenAt = Date.now();
  win.nodes.set(created.id, node);
  scheduleSave();
  scheduleSnapshot(windowId);
  return buildSnapshot(windowId);
}

async function createSmartFolderForPanel(payload = {}) {
  const smartFolders = await getSmartFolders();
  const folder = createSmartFolder({
    ...payload,
    updatedAt: Date.now(),
  });
  await setSmartFolders([folder, ...smartFolders]);
  return folder;
}

async function updateSmartFolder(folderId, payload = {}) {
  const smartFolders = await getSmartFolders();
  const nextFolders = smartFolders.map((folder) =>
    folder.id === folderId
      ? createSmartFolder({
          ...folder,
          ...payload,
          id: folder.id,
          updatedAt: Date.now(),
        })
      : folder,
  );
  await setSmartFolders(nextFolders);
  return nextFolders.find((folder) => folder.id === folderId) || null;
}

async function deleteSmartFolder(folderId) {
  const smartFolders = await getSmartFolders();
  await setSmartFolders(smartFolders.filter((folder) => folder.id !== folderId));
}

async function archiveTabs(windowId, rawTabIds, { close = true } = {}) {
  const snapshot = await syncWindow(windowId);
  const win = ensureWindowState(windowId);
  const tabsById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  const tabIds = uniqueSortedIds(rawTabIds, tabsById, { allowPinned: false });
  if (!tabIds.length) return [];

  const archived = await getArchivedTabs();
  const archivedPairs = tabIds
    .map((tabId) => {
      const tab = tabsById.get(tabId);
      const node = win.nodes.get(tabId);
      const url = sanitizeSnapshotUrl(tab?.url || tab?.pendingUrl || '');
      if (!tab || !node || !url) return null;
      return {
        tabId,
        entry: createArchivedTab({
          title: tab.title || url,
          url,
          customTitle: node.customTitle || '',
          favIconUrl: tab.favIconUrl || '',
          archivedAt: Date.now(),
          lastSeenAt: node.lastSeenAt || Date.now(),
          windowId,
        }),
      };
    })
    .filter(Boolean);

  const entries = archivedPairs.map((item) => item.entry);

  if (!entries.length) return [];

  await setArchivedTabs([...entries, ...archived]);
  if (close) {
    await chrome.tabs.remove(archivedPairs.map((item) => item.tabId));
  }
  return entries;
}

async function restoreArchivedTab(archiveId, windowId = null) {
  const archived = await getArchivedTabs();
  const entry = archived.find((item) => item.id === archiveId);
  if (!entry?.url) return null;

  let targetWindowId = windowId;
  if (targetWindowId == null) {
    const currentWindow = await chrome.windows.getCurrent().catch(() => null);
    targetWindowId = currentWindow?.id ?? null;
  }
  if (targetWindowId == null) return null;

  const created = await chrome.tabs.create({ windowId: targetWindowId, url: entry.url, active: true });
  const win = ensureWindowState(targetWindowId);
  const node = win.nodes.get(created.id) || createNode();
  node.customTitle = entry.customTitle || '';
  node.lastSeenAt = Date.now();
  win.nodes.set(created.id, node);
  await setArchivedTabs(archived.filter((item) => item.id !== archiveId));
  scheduleSave();
  scheduleSnapshot(targetWindowId);
  return buildSnapshot(targetWindowId);
}

async function deleteArchivedTab(archiveId) {
  const archived = await getArchivedTabs();
  await setArchivedTabs(archived.filter((item) => item.id !== archiveId));
}

async function setPinnedHome(windowId, tabId, { url = '', title = '' } = {}) {
  await syncWindow(windowId);
  const node = ensureWindowState(windowId).nodes.get(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!node || !tab) return;

  node.pinnedHomeUrl = sanitizeSnapshotUrl(url || tab.url || tab.pendingUrl || '');
  node.pinnedHomeTitle = title?.trim() || tab.title || node.pinnedHomeTitle || 'Pinned tab';
  scheduleSave();
  scheduleSnapshot(windowId);
}

async function resetPinnedHome(windowId, tabId) {
  await syncWindow(windowId);
  const node = ensureWindowState(windowId).nodes.get(tabId);
  if (!node?.pinnedHomeUrl) return null;

  await chrome.tabs.update(tabId, { url: node.pinnedHomeUrl, active: true }).catch(() => {});
  scheduleSnapshot(windowId);
  return buildSnapshot(windowId);
}

async function openPinnedAsRegular(windowId, tabId) {
  await syncWindow(windowId);
  const node = ensureWindowState(windowId).nodes.get(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = sanitizeSnapshotUrl(node?.pinnedHomeUrl || tab?.url || tab?.pendingUrl || '');
  if (!tab || !url) return null;

  const created = await chrome.tabs.create({ windowId, url, active: true });
  const nextNode = ensureWindowState(windowId).nodes.get(created.id) || createNode();
  nextNode.lastSeenAt = Date.now();
  ensureWindowState(windowId).nodes.set(created.id, nextNode);
  scheduleSave();
  scheduleSnapshot(windowId);
  return buildSnapshot(windowId);
}

async function exportSidebarData() {
  return {
    snapshots: await getSavedSnapshots(),
    favorites: await getFavorites(),
    smartFolders: await getSmartFolders(),
    archivedTabs: await getArchivedTabs(),
  };
}

async function importSidebarData(payload = {}) {
  await setSavedSnapshots(Array.isArray(payload.snapshots) ? payload.snapshots.map((item) => createSavedSnapshot(item)) : []);
  await setFavorites(Array.isArray(payload.favorites) ? payload.favorites.map((item) => createFavorite(item)) : []);
  await setSmartFolders(Array.isArray(payload.smartFolders) ? payload.smartFolders.map((item) => createSmartFolder(item)) : []);
  await setArchivedTabs(Array.isArray(payload.archivedTabs) ? payload.archivedTabs.map((item) => createArchivedTab(item)) : []);
  return {
    snapshots: Array.isArray(payload.snapshots) ? payload.snapshots.length : 0,
    favorites: Array.isArray(payload.favorites) ? payload.favorites.length : 0,
    smartFolders: Array.isArray(payload.smartFolders) ? payload.smartFolders.length : 0,
    archivedTabs: Array.isArray(payload.archivedTabs) ? payload.archivedTabs.length : 0,
  };
}

async function withUndo(windowId, label, operation) {
  if (windowId != null && windowId !== chrome.windows.WINDOW_ID_NONE) {
    await pushUndoSnapshot(windowId, label);
  }
  return operation();
}

async function highlightTabs(windowId, rawTabIds, activeId = null) {
  const tabs = await chrome.tabs.query({ windowId });
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const tabIds = [...new Set(rawTabIds)].filter((tabId) => tabsById.has(tabId));
  if (!tabIds.length) return;

  const sortedIndexes = tabIds.map((tabId) => tabsById.get(tabId).index).sort((a, b) => a - b);
  if (activeId && tabsById.has(activeId)) {
    const activeIndex = tabsById.get(activeId).index;
    const remainingIndexes = sortedIndexes.filter((index) => index !== activeIndex);
    await chrome.tabs.highlight({ windowId, tabs: [activeIndex, ...remainingIndexes] });
    return;
  }

  await chrome.tabs.highlight({ windowId, tabs: sortedIndexes });
}

async function bootstrap() {
  await ensureStateLoaded();

  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const liveIds = new Set(windows.map((window) => window.id));

  for (const window of windows) {
    await syncWindow(window.id);
  }

  for (const windowId of [...windowsState.keys()]) {
    if (!liveIds.has(windowId)) {
      windowsState.delete(windowId);
    }
  }

  scheduleSave();
}

chrome.runtime.onInstalled.addListener(() => {
  fireAndForget(
    (async () => {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
      await bootstrap();
    })(),
    'install bootstrap',
  );
});

chrome.runtime.onStartup.addListener(() => {
  fireAndForget((async () => {
    await bootstrap();
  })(), 'startup bootstrap');
});

fireAndForget((async () => {
  await bootstrap();
})(), 'initial bootstrap');

chrome.tabs.onCreated.addListener((tab) => {
  scheduleWindowRefresh(tab.windowId, 'tab created');
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) return;
  scheduleWindowRefresh(info.windowId, `tab removed ${tabId}`);
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  scheduleWindowRefresh(moveInfo.windowId, `tab moved ${tabId}`);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  scheduleWindowRefresh(attachInfo.newWindowId, `tab attached ${tabId}`);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  scheduleWindowRefresh(detachInfo.oldWindowId, `tab detached ${tabId}`);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ('groupId' in changeInfo || 'pinned' in changeInfo || 'title' in changeInfo || 'url' in changeInfo) {
    scheduleWindowRefresh(tab.windowId, `tab structural update ${tabId}`);
    return;
  }

  broadcastMessage({ type: 'TAB_UPDATED', tabId, changeInfo, tab });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabByWindow.set(activeInfo.windowId, activeInfo.tabId);
  const win = ensureWindowState(activeInfo.windowId);
  const node = win.nodes.get(activeInfo.tabId);
  if (node) {
    node.lastSeenAt = Date.now();
    scheduleSave();
  }
  broadcastMessage({ type: 'TAB_ACTIVATED', tabId: activeInfo.tabId, windowId: activeInfo.windowId });
  scheduleSnapshot(activeInfo.windowId);
});

chrome.tabs.onHighlighted.addListener((highlightInfo) => {
  broadcastMessage({ type: 'TABS_HIGHLIGHTED', tabIds: highlightInfo.tabIds, windowId: highlightInfo.windowId });
});

chrome.tabGroups.onCreated.addListener((group) => {
  scheduleWindowRefresh(group.windowId, `group created ${group.id}`);
});

chrome.tabGroups.onUpdated.addListener((group) => {
  scheduleWindowRefresh(group.windowId, `group updated ${group.id}`);
});

chrome.tabGroups.onMoved.addListener((group) => {
  scheduleWindowRefresh(group.windowId, `group moved ${group.id}`);
});

chrome.tabGroups.onRemoved.addListener((group) => {
  scheduleWindowRefresh(group.windowId, `group removed ${group.id}`);
});

chrome.windows.onRemoved.addListener((windowId) => {
  windowsState.delete(windowId);
  lastActiveTabByWindow.delete(windowId);
  fireAndForget(setUndoEntries(windowId, []), `clear undo stack ${windowId}`);
  scheduleSave();
});

chrome.action.onClicked.addListener((tab) => {
  fireAndForget(chrome.sidePanel.open({ windowId: tab.windowId }), 'open side panel');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  fireAndForget(
    (async () => {
      try {
        switch (message.type) {
          case 'GET_INIT_STATE': {
            const windowId = message.windowId ?? (await chrome.windows.getCurrent()).id;
            sendResponse(await buildSnapshot(windowId));
            return;
          }

          case 'GET_SAVED_SNAPSHOTS':
            sendResponse({ snapshots: await getSavedSnapshots() });
            return;

          case 'GET_FAVORITES':
            sendResponse({ favorites: await getFavorites() });
            return;

          case 'GET_SMART_FOLDERS':
            sendResponse({ smartFolders: await getSmartFolders() });
            return;

          case 'GET_ARCHIVED_TABS':
            sendResponse({ archivedTabs: await getArchivedTabs() });
            return;

          case 'GET_UNDO_STATUS':
            sendResponse(await getUndoStatus(message.windowId));
            return;

          case 'ACTIVATE_TAB':
            await chrome.tabs.update(message.tabId, { active: true });
            break;

          case 'HIGHLIGHT_TABS':
            await highlightTabs(message.windowId, message.tabIds, message.activeId);
            break;

          case 'CLOSE_TAB':
            await withUndo((await chrome.tabs.get(message.tabId).catch(() => null))?.windowId, 'Close tab', () => chrome.tabs.remove(message.tabId));
            break;

          case 'CLOSE_TAB_TREE':
            await withUndo(message.windowId, 'Close branch', () => closeTabTree(message.windowId, message.tabId));
            break;

          case 'CLOSE_OTHER_TABS':
            await withUndo(message.windowId, 'Close others', () => closeOtherTabs(message.windowId, message.tabId));
            break;

          case 'NEW_TAB':
            await chrome.tabs.create({
              windowId: message.windowId,
              openerTabId: message.openerTabId,
              active: true,
            });
            break;

          case 'DUPLICATE_TAB':
            await chrome.tabs.duplicate(message.tabId);
            break;

          case 'ARCHIVE_TABS':
            await withUndo(message.windowId, 'Archive tabs', () => archiveTabs(message.windowId, message.tabIds));
            break;

          case 'MUTE_TAB':
            await chrome.tabs.update(message.tabId, { muted: message.muted });
            break;

          case 'PIN_TAB':
            await chrome.tabs.update(message.tabId, { pinned: message.pinned });
            break;

          case 'MOVE_TO_NEW_WINDOW':
            await chrome.windows.create({ tabId: message.tabId });
            break;

          case 'SET_COLLAPSED':
            await setCollapsed(message.windowId, message.tabId, message.collapsed);
            break;

          case 'SET_FOLDER_COLLAPSED':
            await setFolderCollapsed(message.windowId, message.folderId, message.collapsed);
            break;

          case 'SET_ALL_COLLAPSED':
            await setAllCollapsed(message.windowId, message.collapsed);
            break;

          case 'MOVE_TAB_IN_TREE':
            await moveTabInTree(message);
            break;

          case 'RELOAD_TAB':
            await chrome.tabs.reload(message.tabId);
            break;

          case 'DISCARD_TAB':
            await chrome.tabs.discard(message.tabId).catch(() => {});
            break;

          case 'RENAME_TAB':
            await renameTab(message.windowId, message.tabId, message.title);
            break;

          case 'SET_PINNED_HOME':
            await setPinnedHome(message.windowId, message.tabId, {
              url: message.url,
              title: message.title,
            });
            break;

          case 'RESET_PINNED_HOME':
            sendResponse({
              snapshot: await resetPinnedHome(message.windowId, message.tabId),
            });
            return;

          case 'OPEN_PINNED_AS_REGULAR':
            sendResponse({
              snapshot: await openPinnedAsRegular(message.windowId, message.tabId),
            });
            return;

          case 'CREATE_FOLDER_FROM_TABS':
            sendResponse({
              folder: await createFolderFromTabs(message.windowId, message.tabIds, message.title),
            });
            return;

          case 'REMOVE_TABS_FROM_FOLDER':
            await withUndo(message.windowId, 'Remove tabs from folder', () => removeTabsFromFolder(message.windowId, message.tabIds));
            break;

          case 'RENAME_GROUP':
            await renameGroup(message.groupId, message.title);
            break;

          case 'SET_GROUP_COLOR':
            await setGroupColor(message.groupId, message.color);
            break;

          case 'RENAME_FOLDER':
            await renameFolder(message.windowId, message.folderId, message.title);
            break;

          case 'REMOVE_FOLDER':
            await withUndo(message.windowId, 'Remove folder', () => removeFolder(message.windowId, message.folderId));
            break;

          case 'CLOSE_FOLDER':
            await withUndo(message.windowId, 'Close folder', () => closeFolder(message.windowId, message.folderId));
            break;

          case 'MOVE_TABS_TO_FOLDER':
            await moveTabsToFolder(message.windowId, message.tabIds, message.folderId);
            break;

          case 'MOVE_FOLDER_BLOCK':
            await moveFolderBlock(message.windowId, message.folderId, message.targetFolderId, message.position);
            break;

          case 'MOVE_GROUP_BLOCK':
            await moveGroupBlock(message.windowId, message.groupId, message.targetGroupId, message.position);
            break;

          case 'BATCH_CLOSE_TABS':
            await withUndo(message.windowId, 'Close selected tabs', () => batchCloseTabs(message.windowId, message.tabIds));
            break;

          case 'BATCH_PIN_TABS':
            await batchPinTabs(message.windowId, message.tabIds, message.pinned);
            break;

          case 'BATCH_MUTE_TABS':
            await batchMuteTabs(message.windowId, message.tabIds, message.muted);
            break;

          case 'BATCH_BOOKMARK_TABS':
            await batchBookmarkTabs(message.windowId, message.tabIds);
            break;

          case 'BATCH_MOVE_TO_NEW_WINDOW':
            await batchMoveToNewWindow(message.windowId, message.tabIds);
            break;

          case 'BATCH_GROUP_TABS':
            sendResponse({
              groupId: await batchGroupTabs(message.windowId, message.tabIds, message.title, message.color),
            });
            return;

          case 'MOVE_TABS_TO_GROUP':
            await moveTabsToGroup(message.windowId, message.tabIds, message.groupId);
            break;

          case 'BATCH_UNGROUP_TABS':
            await withUndo(message.windowId, 'Ungroup selected tabs', () => batchUngroupTabs(message.windowId, message.tabIds));
            break;

          case 'SAVE_SNAPSHOT':
            sendResponse({
              snapshot: await saveCurrentSnapshot(message.windowId, message.title),
            });
            return;

          case 'RENAME_SNAPSHOT':
            await renameSavedSnapshot(message.snapshotId, message.title);
            break;

          case 'DELETE_SNAPSHOT':
            await deleteSavedSnapshot(message.snapshotId);
            break;

          case 'RESTORE_SNAPSHOT':
            sendResponse({
              snapshot: await restoreSavedSnapshot(message.snapshotId),
            });
            return;

          case 'SAVE_FAVORITE_FROM_TAB':
            sendResponse({
              favorite: await saveFavoriteFromTab(message.tabId, message.title),
            });
            return;

          case 'DELETE_FAVORITE':
            await deleteFavorite(message.favoriteId);
            break;

          case 'OPEN_FAVORITE':
            sendResponse({
              snapshot: await openFavorite(message.windowId, message.favoriteId),
            });
            return;

          case 'CREATE_SMART_FOLDER':
            sendResponse({
              smartFolder: await createSmartFolderForPanel(message.folder),
            });
            return;

          case 'UPDATE_SMART_FOLDER':
            sendResponse({
              smartFolder: await updateSmartFolder(message.folderId, message.folder),
            });
            return;

          case 'DELETE_SMART_FOLDER':
            await deleteSmartFolder(message.folderId);
            break;

          case 'RESTORE_ARCHIVED_TAB':
            sendResponse({
              snapshot: await restoreArchivedTab(message.archiveId, message.windowId),
            });
            return;

          case 'DELETE_ARCHIVED_TAB':
            await deleteArchivedTab(message.archiveId);
            break;

          case 'EXPORT_SIDEBERY_DATA':
            sendResponse(await exportSidebarData());
            return;

          case 'IMPORT_SIDEBERY_DATA':
            sendResponse(await importSidebarData(message.payload));
            return;

          case 'UNDO_LAST_ACTION':
            sendResponse({
              snapshot: await undoLastAction(message.windowId),
            });
            return;

          case 'GET_BOOKMARKS':
            sendResponse({ tree: await chrome.bookmarks.getTree() });
            return;

          case 'CREATE_BOOKMARK':
            sendResponse({
              node: await chrome.bookmarks.create({
                parentId: message.parentId,
                title: message.title,
                url: message.url,
              }),
            });
            return;

          case 'BOOKMARK_TAB':
            await bookmarkTab(message.tabId);
            break;

          case 'REMOVE_BOOKMARK':
            requireConfirmed(message, 'Bookmark deletion');
            await chrome.bookmarks.remove(message.id);
            break;

          case 'REMOVE_BOOKMARK_TREE':
            requireConfirmed(message, 'Bookmark folder deletion');
            await chrome.bookmarks.removeTree(message.id);
            break;

          case 'OPEN_BOOKMARK':
            if (message.newTab) {
              await chrome.tabs.create({ url: message.url });
            } else {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (activeTab?.id) {
                await chrome.tabs.update(activeTab.id, { url: message.url });
              }
            }
            break;

          case 'GET_HISTORY':
            sendResponse({
              items: await chrome.history.search({
                text: message.query ?? '',
                maxResults: message.maxResults ?? 100,
                startTime: message.startTime ?? 0,
              }),
            });
            return;

          case 'GET_RECENTLY_CLOSED':
            sendResponse({ items: await getRecentlyClosed(message.maxResults ?? 12) });
            return;

          case 'RESTORE_LAST_CLOSED':
            await chrome.sessions.restore();
            break;

          case 'RESTORE_SESSION':
            await chrome.sessions.restore(message.sessionId);
            break;

          case 'TOGGLE_GROUP_COLLAPSED':
            await chrome.tabGroups.update(message.groupId, { collapsed: message.collapsed });
            break;

          case 'CREATE_TAB_GROUP':
            sendResponse({
              groupId: await groupTabTree(message.tabId, message.title, message.color),
            });
            return;

          case 'UNGROUP_TAB_TREE':
            await withUndo(message.windowId, 'Ungroup branch', () => ungroupTabTree(message.windowId, message.tabId));
            break;

          case 'UNGROUP_ALL':
            await withUndo(message.windowId, 'Ungroup all', () => ungroupAll(message.windowId, message.groupId));
            break;

          case 'CLOSE_GROUP':
            await withUndo(message.windowId, 'Close group', () => closeGroup(message.windowId, message.groupId));
            break;

          default:
            break;
        }

        sendResponse({ ok: true });
      } catch (error) {
        console.error('[Avenue] message handler failed', error);
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })(),
    `handle message ${message.type}`,
  );

  return true;
});
