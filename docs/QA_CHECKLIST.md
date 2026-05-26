# Avenue QA Checklist

Run destructive checks in an isolated Chrome profile, not Jordan's daily browser profile.

Suggested isolated launch on Windows PowerShell:

```powershell
Start-Process chrome.exe -ArgumentList '--user-data-dir=%TEMP%\avenue-qa-profile','--load-extension=C:\Users\jlang\Github\avenue','--no-first-run','--disable-sync','https://example.com','https://developer.chrome.com','https://github.com','https://www.wikipedia.org'
```

## Safe Baseline

- Load Avenue from this checkout.
- Confirm the extension card shows the current `manifest.json` version.
- Open the side panel.
- Confirm search placeholder says `Search tabs`.
- Confirm no Spaces, workspace, saved-view, or Peek controls are visible.

## Selection

- Click a higher tab, then Shift-click a lower tab.
- Click a lower tab, then Shift-click a higher tab.
- Confirm the same range is selected in both directions.
- Press Escape once to clear search text when search is active.
- Press Escape again to clear multi-selection.

## Groups And Folders

- Select several tabs and create a folder.
- Drag one tab into the folder.
- Drag one tab out of the folder.
- Convert the folder to a Chrome tab group.
- Convert the Chrome tab group back to a folder.
- Drag a whole group above and below another visible group.
- Drag a whole group into a folder.
- Ungroup selected tabs.

## Destructive Flows

- Close selected tabs, then use Undo.
- Move selected tabs to a new window.
- Archive selected tabs, then restore one from Library > Archive.
- Delete one archive entry.
- Save a current snapshot, restore it, rename it, then delete it.
- Export sidebar data.
- Import the exported data into the isolated profile.

## Large Session

- Create or restore a session with more than 300 visible rows.
- Scroll the tab list top to bottom.
- Confirm row rendering stays responsive.
- Confirm search narrows the virtualized list.
- Confirm active tab, pinned tabs, groups, and folders remain visually clear while scrolling.

## Narrow Width

- Drag the side panel to its narrowest width.
- Confirm the search row, tab controls, pinned section, group rows, folder rows, and bottom nav do not overlap.
- Open the context menu at narrow width.
- Confirm common actions remain readable and destructive actions stay at the bottom.
