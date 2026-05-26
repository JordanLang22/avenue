# Avenue Changelog

## 1.0.3

- Fixed settings panel close focus handling to avoid Chrome's blocked `aria-hidden` warning.
- Added a regression test for the settings close-button mouse focus path.
- Added `unlimitedStorage` for large saved sessions and undo stacks.
- Fixed undo so it restores missing saved tabs without deleting newer tabs in the current window.
- Restored the visible favorites section and favorite row actions.
- Added confirmation protection for bookmark and bookmark-folder deletion.
- Reworked packaging to create release zips from Node instead of requiring a system `zip` binary.

## 1.0.2

- Added real viewport row virtualization for large tab sessions.
- Added command-helper tests for selection filtering and group/folder block moves.
- Split static side-panel helpers into focused modules.
- Debounced background tab/group event refreshes to reduce churn during drag and group operations.
- Added install, rollback, platform-limit, and manual QA documentation.
- Updated packaging so release zips include the new modules and docs.

## 1.0.1

- Removed visible Spaces and domain routing controls.
- Added state/render regression tests for settings migration, selection ranges, and partial rendering.
- Added partial row rendering for very large tab sessions.
- Removed the unreadable discarded/stale warning label from tab rows.
- Improved group/folder parity with group dragging, group-to-folder conversion, and folder-to-group conversion.
- Improved context-menu ordering and empty-state copy.
- Removed unused `contextMenus` and broad host permissions.
- Added a package script that creates `dist/avenue-<version>.zip` for rollback-friendly builds.
