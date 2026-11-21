# VBerry

A Chrome-native Manifest V3 vertical tab tree, Tab Group manager, Bookmark Manager, and frameless Unified Quick Search launcher — built for **Chrome's Side Panel** and **Vivaldi's Web Panel**, with lossless import support for original Firefox [Sidebery](https://github.com/mbnuqw/sidebery) v5 backups and snapshots.

## Features (v6.5.0)

### Frameless Quick Search Popup & Unified Search
- **Frameless Toolbar Action Popup (`popup/index.html`)**: Click the VBerry toolbar button or press your **Activate Extension** shortcut to open a fast, frameless search popup with automatic search-bar focus on both Chrome and Vivaldi.
- **Unified Search Panel**: Dedicated Search panel (to the left of Bookmarks, enabled by default) that searches **Tabs → Bookmarks → History** in ranked order with per-source toggles (`Tabs`, `Bookmarks`, `History`) and an option to hide Unified Search in the main Side Panel while keeping it in the popup.
- **Empty-State Recent Lists & Recent Bookmarks MRU**: Configure whether to show Recent Tabs, Recent Bookmarks (tracked by most-recently-opened MRU + Chrome visit history), and Recent History before typing.
- **Adjustable History Time Range**: Filter History panel and Unified Search history results by `1 day`, `3 days`, `7 days` (default), `1 month`, `3 months`, `1 year`, or `All time`.
- **Keyboard-First Navigation**: Use `Tab` / `Shift+Tab` + `Enter` to navigate and activate UI controls (skipping result rows), `↑` / `↓` + `Enter` to highlight and open results, and `Esc` to clear or close.
- **Configurable Search Behavior**: Toggle auto-highlighting the top match, searching across all tab groups vs. the active group, clearing search after selecting a result or switching panels, and auto-focusing search on panel switch.

### Vertical Tab Trees & Tab Group Panels
- **1:1 Chrome Tab Groups as Panels**: Every native Chrome Tab Group (`chrome.tabGroups`) in the current window appears as a panel pill with its exact title, Chrome color, and collapse state. Ungrouped tabs live in `Tabs`, and pinned tabs live in a dedicated top strip.
- **Vivaldi-Aware**: Automatically detects Vivaldi, falls back seamlessly to persisted virtual group panels (where `chrome.tabGroups` is unsupported), persists tab trees & virtual groups across browser restarts, and opens `chrome://vivaldi-webui/startpage` for new tabs while keeping Chrome's native New Tab Page on Chrome.
- **Tab Trees & Multi-Select**: Automatic parent-child nesting via `openerTabId`, drag-and-drop reordering & nesting, fold/unfold branches, indent/outdent, `Shift` / `Cmd` / `Ctrl` multi-select (including unloaded tabs), subtree drag-to-group, instant `mousedown` tab switching, bottom-of-stack new tabs, and tree-safe bulk unloading.
- **Saved Panels & URL Auto-Group Rules**: Keep saved panels visible even when empty and automatically route matching URLs into their Tab Group.

### Full Bookmark Manager
- **Inline Toolbar & Modals**: Add bookmarks, bookmark the active tab, create folders, edit/move items, sort folders A–Z, and expand/collapse all folders directly in the panel.
- **Drag-and-Drop & Context Menus**: Reorder and nest bookmarks or folders via drag-and-drop, open entire folders as tabs or as a new Tab Group, reveal search matches in the folder tree, or edit/delete on hover.
- **Trash Exclusion**: Automatically excludes Vivaldi's root `Trash` bookmark folder everywhere (Bookmarks panel, Unified Search, folder pickers, and omnibox).

### History, Snapshots & Native Chrome Integration
- **History & Recently Closed**: Search recent browsing history (respecting your History Time Range) and restore recently closed tabs or windows.
- **Tree-Preserving Snapshots**: Capture manual or periodic auto-snapshots (`chrome.alarms`, configurable Snapshot Limit) of windows, pinned tabs, groups, and nested tab trees; restore in the current or a new window, or export to Markdown.
- **Omnibox & Context Menus**: Type `=` in the address bar to jump to open tabs or bookmarks; right-click the VBerry toolbar icon for **Open VBerry Side Panel**; right-click any webpage or link for **Send to VBerry Group**; right-click tabs, groups, bookmarks, history, sessions, or snapshots for rich actions.
- **First-Run Welcome Guide**: Automatically opens on fresh install to walk through recommended shortcuts, toolbar pinning, Vivaldi Web Panel setup, and key features.

### Sidebery v5 Import & Customization
- **Lossless Sidebery v5 Import**: Open **Settings** (`⚙`) to import original Sidebery JSON backups (`sidebery-data-*.json`), standalone or delta-compressed Sidebery snapshots, or VBerry backups — mapping panels to Chrome Tab Group colors + URL `moveRules`, compatible settings, and custom CSS.
- **Customizable UI**: Theme (Auto / Light / Dark), Density (Comfortable / Compact), Browser Mode (Auto / Chrome / Vivaldi), Font Size, Tab Icon Size, Control Bar Icon Size, Tab Close & Caret Icon Size, and Custom Sidebar CSS.

## Recommended Shortcuts

Configure shortcuts via **VBerry Settings → Change Global Shortcuts…** (or `chrome://extensions/shortcuts` / `vivaldi://extensions/shortcuts`):

| Action | Default / Tip |
| --- | --- |
| **Quick Search (Frameless Popup)** (`_execute_action`) | Bind a quick hotkey (e.g., `Ctrl+Shift+K` or `Alt+Space`) |
| **Toggle VBerry Side Panel** | `Ctrl+E` (`MacCtrl+E` on macOS) — or right-click the toolbar icon |
| **Open new tab in active group** | `Ctrl+Space` (`MacCtrl+Space` on macOS) |
| **Create tab snapshot** | Optional |
| **Unload inactive tabs in current window** | Optional |

## Quick Install (Prebuilt Release)

1. Download `vberry-v6.5.0.zip` from the [Releases](https://github.com/justinallahyari/VBerry/releases) page and unzip it.
2. **Chrome**: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder. The first-run Welcome page will open to guide you through shortcut setup.
3. **Vivaldi**: Open `vivaldi://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder. Copy your Web Panel URL from the Welcome page (or add a Web Panel pointing to `chrome-extension://<your-extension-id>/sidepanel.html`).
   *(Optional)* Enable the CSS mods in [`vivaldi css hacks/`](./vivaldi%20css%20hacks) via **Settings → Appearance → Custom UI Modifications**.

## Build from Source

```bash
npm install
npm run build
```

This outputs the unpacked extension into `addon/`. Run `npm run package` to build and package `dist/vberry-v6.5.0.zip`, `npm run typecheck` to typecheck, and `npm test` to run unit tests.

## License

Licensed under the [MIT License](./LICENSE).
