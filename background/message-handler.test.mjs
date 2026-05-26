import assert from 'node:assert/strict';
import { test } from 'node:test';

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
  };
}

function createChromeMock({
  storage = {},
  tabs = [],
  removedTabIds = [],
  bookmarkRemovals = [],
  createdTabs = [],
  groupUpdates = [],
} = {}) {
  const onMessage = createEvent();
  let nextTabId = Math.max(100, ...tabs.map((tab) => tab.id)) + 1;

  globalThis.chrome = {
    action: { onClicked: createEvent() },
    bookmarks: {
      getTree: async () => [],
      remove: async (id) => {
        bookmarkRemovals.push({ kind: 'bookmark', id });
      },
      removeTree: async (id) => {
        bookmarkRemovals.push({ kind: 'tree', id });
      },
    },
    history: {
      search: async () => [],
    },
    runtime: {
      id: 'test-extension',
      onInstalled: createEvent(),
      onMessage,
      onStartup: createEvent(),
      sendMessage: async () => ({}),
    },
    sessions: {
      getRecentlyClosed: async () => [],
      restore: async () => undefined,
    },
    sidePanel: {
      open: async () => undefined,
      setPanelBehavior: async () => undefined,
    },
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          }
          return { [keys]: storage[keys] };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      onCreated: createEvent(),
      onMoved: createEvent(),
      onRemoved: createEvent(),
      onUpdated: createEvent(),
      query: async () => [],
      update: async (groupId, update) => {
        groupUpdates.push({ groupId, update });
      },
    },
    tabs: {
      onActivated: createEvent(),
      onAttached: createEvent(),
      onCreated: createEvent(),
      onDetached: createEvent(),
      onHighlighted: createEvent(),
      onMoved: createEvent(),
      onRemoved: createEvent(),
      onUpdated: createEvent(),
      create: async (tab) => {
        const created = {
          id: nextTabId++,
          index: tabs.length,
          windowId: tab.windowId,
          active: !!tab.active,
          highlighted: !!tab.active,
          pinned: !!tab.pinned,
          title: tab.url,
          url: tab.url,
          groupId: -1,
        };
        tabs.push(created);
        createdTabs.push(created);
        return created;
      },
      get: async (tabId) => tabs.find((tab) => tab.id === tabId) ?? null,
      group: async () => 501,
      highlight: async () => undefined,
      move: async () => undefined,
      query: async ({ windowId } = {}) => tabs.filter((tab) => windowId == null || tab.windowId === windowId),
      remove: async (tabIds) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        removedTabIds.push(...ids);
        for (const tabId of ids) {
          const index = tabs.findIndex((tab) => tab.id === tabId);
          if (index !== -1) tabs.splice(index, 1);
        }
      },
      ungroup: async () => undefined,
      update: async (tabId, update) => {
        const tab = tabs.find((item) => item.id === tabId);
        if (tab) Object.assign(tab, update);
        return tab;
      },
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      WINDOW_ID_NONE: -1,
      onRemoved: createEvent(),
      create: async ({ url }) => {
        const windowId = 99;
        tabs.push({
          id: nextTabId++,
          index: 0,
          windowId,
          active: true,
          highlighted: true,
          pinned: false,
          title: url,
          url,
          groupId: -1,
        });
        return { id: windowId };
      },
      getAll: async () => [{ id: 7 }],
      getCurrent: async () => ({ id: 7 }),
    },
  };

  return { onMessage };
}

async function importBackground(label) {
  await import(`../background.js?${label}=${Date.now()}-${Math.random()}`);
}

async function sendTo(handler, message) {
  return new Promise((resolve) => {
    handler(message, {}, resolve);
  });
}

test('CLOSE_TAB records undo state and removes the tab', async () => {
  const removedTabIds = [];
  const storage = {};
  const tabs = [
    {
      id: 11,
      index: 0,
      windowId: 7,
      active: true,
      highlighted: true,
      pinned: false,
      title: 'Closable tab',
      url: 'https://example.com/',
      groupId: -1,
    },
  ];

  const { onMessage } = createChromeMock({ storage, tabs, removedTabIds });

  await importBackground('close-tab-test');

  const handler = onMessage.listeners[0];
  assert.equal(typeof handler, 'function');

  const response = await sendTo(handler, { type: 'CLOSE_TAB', tabId: 11 });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(removedTabIds, [11]);
});

test('UNDO_LAST_ACTION restores missing snapshot tabs without removing newer tabs', async () => {
  const storage = {
    sb_undo_stack_v1: {
      7: [
        {
          label: 'Close tab',
          createdAt: 1,
          snapshot: {
            title: 'Before close',
            createdAt: 1,
            updatedAt: 1,
            entryCount: 2,
            entries: [
              {
                key: '11',
                url: 'https://closed.example/',
                title: 'Closed tab',
                pinned: false,
                active: true,
                groupId: -1,
              },
              {
                key: '12',
                url: 'https://kept.example/',
                title: 'Kept tab',
                pinned: false,
                active: false,
                groupId: -1,
              },
            ],
            groups: [],
            folders: [],
          },
        },
      ],
    },
  };
  const removedTabIds = [];
  const createdTabs = [];
  const tabs = [
    {
      id: 12,
      index: 0,
      windowId: 7,
      active: false,
      highlighted: false,
      pinned: false,
      title: 'Kept tab',
      url: 'https://kept.example/',
      groupId: -1,
    },
    {
      id: 99,
      index: 1,
      windowId: 7,
      active: true,
      highlighted: true,
      pinned: false,
      title: 'New work',
      url: 'https://new.example/',
      groupId: -1,
    },
  ];
  const { onMessage } = createChromeMock({ storage, tabs, removedTabIds, createdTabs });

  await importBackground('undo-preserves-new-tabs');

  const response = await sendTo(onMessage.listeners[0], { type: 'UNDO_LAST_ACTION', windowId: 7 });

  assert.equal(response.snapshot.windowId, 7);
  assert.deepEqual(removedTabIds, []);
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].url, 'https://closed.example/');
  assert.equal(tabs.some((tab) => tab.id === 99 && tab.url === 'https://new.example/'), true);
});

test('bookmark delete messages require explicit confirmation', async () => {
  const bookmarkRemovals = [];
  const { onMessage } = createChromeMock({ bookmarkRemovals });

  await importBackground('bookmark-confirmation');

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const denied = await sendTo(onMessage.listeners[0], { type: 'REMOVE_BOOKMARK', id: 'abc' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /confirmation/i);
    assert.deepEqual(bookmarkRemovals, []);
  } finally {
    console.error = originalConsoleError;
  }

  const allowed = await sendTo(onMessage.listeners[0], { type: 'REMOVE_BOOKMARK_TREE', id: 'folder', confirmed: true });
  assert.deepEqual(allowed, { ok: true });
  assert.deepEqual(bookmarkRemovals, [{ kind: 'tree', id: 'folder' }]);
});
