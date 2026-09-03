# Chrome Platform Limits

Avenue focuses on Chrome-native vertical tab management, but Chrome extensions have platform limits that affect how they can integrate with the browser.

- No arbitrary page-link previews: Chrome extensions cannot intercept Shift-clicks on arbitrary page links and render a trusted browser-native preview surface over every site. Avenue should not expose a fake preview action.
- No real container tabs: Chrome does not expose Firefox-style contextual identities or per-tab cookie containers to extensions. Avenue groups and folders are visual/workflow organization only.
- No exact Chrome theme color API: Chrome does not provide a reliable side-panel API for reading the active window theme colors. Avenue can offer system/light/dark themes and manual accents, but it cannot perfectly bind to every Chrome theme.
- Side panel width is browser-controlled: Avenue can optimize for narrow layouts, but Chrome owns the side-panel host, drag handle, minimum sizing, and outer browser chrome.
- Extension UI cannot change Chrome toolbar layout: Avenue can blend visually with Chrome, but it cannot remove or restyle browser toolbar controls outside the extension surface.
