import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsPanelController } from './settings-panel.js';

test('settings close button suppresses mouse focus before hiding panel', () => {
  const listeners = new Map();
  const closeButton = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };
  const controller = createSettingsPanelController();

  assert.equal(typeof controller.bindCloseButton, 'function');
  controller.bindCloseButton(closeButton);

  let defaultPrevented = false;
  listeners.get('mousedown')?.({
    button: 0,
    preventDefault() {
      defaultPrevented = true;
    },
  });

  assert.equal(defaultPrevented, true);
});
