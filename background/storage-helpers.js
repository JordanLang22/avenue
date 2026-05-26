const SNAPSHOT_STORAGE_KEY = 'sb_saved_snapshots_v1';
const UNDO_STACK_STORAGE_KEY = 'sb_undo_stack_v1';
const FAVORITES_STORAGE_KEY = 'sb_favorites_v1';
const SMART_FOLDER_STORAGE_KEY = 'sb_smart_folders_v1';
const ARCHIVE_STORAGE_KEY = 'sb_archived_tabs_v1';
const MAX_SAVED_SNAPSHOTS = 40;
const MAX_UNDO_PER_WINDOW = 12;
const MAX_FAVORITES = 24;
const MAX_SMART_FOLDERS = 48;
const MAX_ARCHIVED_TABS = 200;

export function createFavorite(seed = {}) {
  return {
    id: seed.id ?? `favorite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof seed.title === 'string' && seed.title.trim() ? seed.title.trim() : 'Favorite',
    url: typeof seed.url === 'string' ? seed.url : '',
    icon: typeof seed.icon === 'string' ? seed.icon.trim().slice(0, 2) : '',
    createdAt: Number.isFinite(seed.createdAt) ? seed.createdAt : Date.now(),
    updatedAt: Number.isFinite(seed.updatedAt) ? seed.updatedAt : Date.now(),
  };
}

export function createSmartFolder(seed = {}) {
  return {
    id: seed.id ?? `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof seed.title === 'string' && seed.title.trim() ? seed.title.trim() : 'Live folder',
    query: typeof seed.query === 'string' ? seed.query.trim() : '',
    icon: typeof seed.icon === 'string' && seed.icon.trim() ? seed.icon.trim().slice(0, 2) : '::',
    collapsed: !!seed.collapsed,
    createdAt: Number.isFinite(seed.createdAt) ? seed.createdAt : Date.now(),
    updatedAt: Number.isFinite(seed.updatedAt) ? seed.updatedAt : Date.now(),
  };
}

export function createArchivedTab(seed = {}) {
  return {
    id: seed.id ?? `archive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof seed.title === 'string' && seed.title.trim() ? seed.title.trim() : 'Archived tab',
    url: typeof seed.url === 'string' ? seed.url : '',
    customTitle: typeof seed.customTitle === 'string' ? seed.customTitle : '',
    favIconUrl: typeof seed.favIconUrl === 'string' ? seed.favIconUrl : '',
    archivedAt: Number.isFinite(seed.archivedAt) ? seed.archivedAt : Date.now(),
    lastSeenAt: Number.isFinite(seed.lastSeenAt) ? seed.lastSeenAt : Date.now(),
    windowId: Number.isFinite(seed.windowId) ? seed.windowId : null,
  };
}

export function createSavedSnapshot(seed = {}) {
  return {
    id: seed.id ?? `snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof seed.title === 'string' && seed.title.trim() ? seed.title.trim() : 'Saved tabs',
    createdAt: Number.isFinite(seed.createdAt) ? seed.createdAt : Date.now(),
    entryCount: Number.isFinite(seed.entryCount) ? seed.entryCount : 0,
    entries: Array.isArray(seed.entries) ? [...seed.entries] : [],
    groups: Array.isArray(seed.groups) ? [...seed.groups] : [],
    folders: Array.isArray(seed.folders) ? [...seed.folders] : [],
  };
}

export function createSavedState(seed = {}) {
  return {
    id: seed.id ?? `state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof seed.title === 'string' && seed.title.trim() ? seed.title.trim() : 'Saved state',
    createdAt: Number.isFinite(seed.createdAt) ? seed.createdAt : Date.now(),
    updatedAt: Number.isFinite(seed.updatedAt) ? seed.updatedAt : Date.now(),
    entryCount: Number.isFinite(seed.entryCount) ? seed.entryCount : 0,
    entries: Array.isArray(seed.entries) ? [...seed.entries] : [],
    groups: Array.isArray(seed.groups) ? [...seed.groups] : [],
    folders: Array.isArray(seed.folders) ? [...seed.folders] : [],
  };
}

export function createUndoEntry(seed = {}) {
  return {
    id: seed.id ?? `undo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: typeof seed.label === 'string' && seed.label.trim() ? seed.label.trim() : 'Last change',
    createdAt: Number.isFinite(seed.createdAt) ? seed.createdAt : Date.now(),
    snapshot: seed.snapshot ? createSavedState(seed.snapshot) : null,
  };
}

export async function getSavedSnapshots() {
  const stored = (await chrome.storage.local.get(SNAPSHOT_STORAGE_KEY))[SNAPSHOT_STORAGE_KEY];
  return Array.isArray(stored) ? stored.map((snapshot) => createSavedSnapshot(snapshot)) : [];
}

export async function setSavedSnapshots(snapshots) {
  await chrome.storage.local.set({
    [SNAPSHOT_STORAGE_KEY]: snapshots.slice(0, MAX_SAVED_SNAPSHOTS),
  });
}

export async function getUndoStacks() {
  const stored = (await chrome.storage.local.get(UNDO_STACK_STORAGE_KEY))[UNDO_STACK_STORAGE_KEY];
  return stored && typeof stored === 'object' ? stored : {};
}

export async function getUndoEntries(windowId) {
  const stacks = await getUndoStacks();
  return Array.isArray(stacks[windowId]) ? stacks[windowId].map((entry) => createUndoEntry(entry)) : [];
}

export async function setUndoEntries(windowId, entries) {
  const stacks = await getUndoStacks();
  stacks[windowId] = entries.slice(0, MAX_UNDO_PER_WINDOW);
  if (!stacks[windowId].length) delete stacks[windowId];
  await chrome.storage.local.set({ [UNDO_STACK_STORAGE_KEY]: stacks });
}

export async function getFavorites() {
  const stored = (await chrome.storage.local.get(FAVORITES_STORAGE_KEY))[FAVORITES_STORAGE_KEY];
  return Array.isArray(stored) ? stored.map((favorite) => createFavorite(favorite)).slice(0, MAX_FAVORITES) : [];
}

export async function setFavorites(favorites) {
  await chrome.storage.local.set({
    [FAVORITES_STORAGE_KEY]: favorites.slice(0, MAX_FAVORITES).map((favorite) => createFavorite(favorite)),
  });
}

export async function getSmartFolders() {
  const stored = (await chrome.storage.local.get(SMART_FOLDER_STORAGE_KEY))[SMART_FOLDER_STORAGE_KEY];
  return Array.isArray(stored) ? stored.map((folder) => createSmartFolder(folder)).slice(0, MAX_SMART_FOLDERS) : [];
}

export async function setSmartFolders(folders) {
  await chrome.storage.local.set({
    [SMART_FOLDER_STORAGE_KEY]: folders.slice(0, MAX_SMART_FOLDERS).map((folder) => createSmartFolder(folder)),
  });
}

export async function getArchivedTabs() {
  const stored = (await chrome.storage.local.get(ARCHIVE_STORAGE_KEY))[ARCHIVE_STORAGE_KEY];
  return Array.isArray(stored) ? stored.map((entry) => createArchivedTab(entry)).slice(0, MAX_ARCHIVED_TABS) : [];
}

export async function setArchivedTabs(entries) {
  await chrome.storage.local.set({
    [ARCHIVE_STORAGE_KEY]: entries.slice(0, MAX_ARCHIVED_TABS).map((entry) => createArchivedTab(entry)),
  });
}
