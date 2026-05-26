const DROP_HINT_CLASSES = ['drop-before', 'drop-after', 'drop-inside'];

export function clearDropHints(root = document) {
  root.querySelectorAll(`.${DROP_HINT_CLASSES.join(',.')}`).forEach((node) => {
    node.classList.remove(...DROP_HINT_CLASSES);
    delete node.dataset.dropLabel;
  });
}

export function dropModeForEvent(event, row) {
  const rect = row.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio < 0.28) return 'before';
  if (ratio > 0.72) return 'after';
  return 'inside';
}

export function setDropHint(row, mode, label = '') {
  if (!row || !DROP_HINT_CLASSES.includes(`drop-${mode}`)) return;
  row.classList.remove(...DROP_HINT_CLASSES);
  row.classList.add(`drop-${mode}`);
  if (label) row.dataset.dropLabel = label;
  else delete row.dataset.dropLabel;
}

export function createAutoScroller({ edge = 38 } = {}) {
  let frame = 0;
  let target = null;
  let velocity = 0;

  function stop() {
    target = null;
    velocity = 0;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  function run() {
    if (!target || !velocity) {
      stop();
      return;
    }

    target.scrollTop += velocity;
    frame = requestAnimationFrame(run);
  }

  function queue(container, event) {
    if (!container) {
      stop();
      return;
    }

    const rect = container.getBoundingClientRect();
    let nextVelocity = 0;

    if (event.clientY < rect.top + edge) {
      nextVelocity = -Math.max(4, Math.ceil((rect.top + edge - event.clientY) / 5));
    } else if (event.clientY > rect.bottom - edge) {
      nextVelocity = Math.max(4, Math.ceil((event.clientY - (rect.bottom - edge)) / 5));
    }

    target = nextVelocity ? container : null;
    velocity = nextVelocity;
    if (!frame && target) frame = requestAnimationFrame(run);
    if (!nextVelocity) stop();
  }

  return { queue, stop };
}

export function createDelayedFolderExpander({ delay = 350, getFolder, expand } = {}) {
  let timer = null;

  function cancel() {
    clearTimeout(timer);
    timer = null;
  }

  function schedule(folderId) {
    cancel();
    timer = setTimeout(() => {
      const folder = getFolder?.(folderId);
      if (folder?.collapsed) expand?.(folderId);
    }, delay);
  }

  return { cancel, schedule };
}
