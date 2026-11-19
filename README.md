# VBerry

A Chrome-native Manifest V3 vertical tab tree & Tab Group manager running in Chrome's Side Panel (and Vivaldi's Web Panel), with full import support for original Firefox [Sidebery](https://github.com/mbnuqw/sidebery) v5 backups and snapshots.

## Features (v6.0.0 — Chrome-Native Rewrite)

- **1:1 Chrome Tab Groups as Panels**: Every native Chrome Tab Group (`chrome.tabGroups`) in the current window appears as a Tabs Panel with its exact title, Chrome color, and collapse state. Ungrouped tabs live in the default `Tabs` panel, and pinned tabs live in a dedicated top strip. On Vivaldi (where `chrome.tabGroups` is unsupported), VBerry automatically falls back to persisted group panels seamlessly.
- **Vivaldi-Aware**: Automatically detects Vivaldi and opens `chrome://vivaldi-webui/startpage` for new tabs while keeping Chrome's native New Tab Page on Chrome.
- **Tab Trees**: Automatic parent-child nesting via `openerTabId`, drag-and-drop reordering & nesting, fold/unfold branches, indent/outdent, Shift/Cmd/Ctrl multi-select (including unloaded tabs), subtree drag-to-group, and smart active-tab unloading (switches to the last-used loaded tab or opens a new tab before discarding).
- **Rich Context Menus**: Right-click tabs, panel pills, empty panel space, bookmarks/folders, history, recently closed sessions, and snapshots to open in a specific tab group, sort, deduplicate, fold/expand branches, unload, mute, bookmark, or snapshot.
- **Native Chrome APIs**:
  - `chrome.sidePanel` with `openPanelOnActionClick`
  - `/_favicon/` endpoint (zero favicon storage bloat)
  - `chrome.tabs.discard`, `chrome.bookmarks`, `chrome.history`, `chrome.sessions`
  - `chrome.omnibox` (`=` keyword) for address-bar tab & bookmark switching
  - `chrome.contextMenus` ("Send to VBerry Group") and `chrome.alarms` (auto-snapshots with configurable Snapshot Limit)
- **Customizable UI**: Theme (Auto/Light/Dark), Density, Font Size, Tab Icon Size, UI Icon Size, and Custom Sidebar CSS.
- **Sidebery v5 Import**: Open **Settings** (`⚙`) to import original Sidebery JSON backups (`sidebery-data-*.json`) or standalone Sidebery snapshots — including delta-compressed snapshots, panels (mapped to Chrome Tab Group colors + URL auto-group `moveRules`), compatible settings, and custom CSS.

## Quick Install (Prebuilt Release)

1. Download `vberry-v6.0.0.zip` from the [Releases](https://github.com/justinallahyari/VBerry/releases) page and unzip it.
2. **Chrome**: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder. Click the VBerry toolbar icon (or press `Ctrl+E` / `MacCtrl+E`).
3. **Vivaldi**: Open `vivaldi://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder. Copy the extension ID and add a Web Panel pointing to:
   ```
   chrome-extension://<your-extension-id>/sidepanel.html
   ```
   *(Optional)* Enable the CSS mods in [`vivaldi css hacks/`](./vivaldi%20css%20hacks) via **Settings → Appearance → Custom UI Modifications**.

## Build from Source

```bash
npm install
npm run build
```

This outputs the unpacked extension into `addon/`. Run `npm run package` to build and package `dist/vberry-v6.0.0.zip`.

## License

Licensed under the [MIT License](./LICENSE).
