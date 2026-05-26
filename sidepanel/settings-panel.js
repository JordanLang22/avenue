const DEFAULT_TRANSITION_MS = 180;

export function createSettingsPanelController({
  getPanel,
  getReturnFocus,
  transitionMs = DEFAULT_TRANSITION_MS,
} = {}) {
  let hideTimer = null;

  function moveFocusOutOfPanel(panel) {
    if (!panel?.contains?.(document.activeElement)) return;

    document.activeElement?.blur?.();
    const fallback = getReturnFocus?.();
    if (fallback && !panel.contains(fallback)) {
      fallback.focus?.({ preventScroll: true });
    }
    if (panel.contains(document.activeElement)) document.activeElement?.blur?.();
  }

  function show() {
    const panel = getPanel?.();
    if (!panel) return;

    clearTimeout(hideTimer);
    panel.dataset.state = 'open';
    panel.inert = false;
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      if (panel.dataset.state === 'open') panel.classList.add('is-open');
    });
  }

  function hide() {
    const panel = getPanel?.();
    if (!panel) return;

    clearTimeout(hideTimer);
    panel.dataset.state = 'closed';
    moveFocusOutOfPanel(panel);
    panel.classList.remove('is-open');
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    hideTimer = setTimeout(() => {
      if (!panel.classList.contains('is-open')) panel.classList.add('hidden');
    }, transitionMs);
  }

  function bindCloseButton(button) {
    if (!button?.addEventListener) return;

    button.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const panel = getPanel?.();
      if (panel) moveFocusOutOfPanel(panel);
    });
  }

  return { show, hide, bindCloseButton };
}
