# VBerry

A Chrome Manifest V3 & Vivaldi port of [Sidebery](https://github.com/mbnuqw/sidebery) (v5.x) running natively in the browser Side Panel, with lossless bidirectional compatibility for Firefox Sidebery JSON backups and snapshots.

## Build from Source

```bash
npm install
npm run build
```

This outputs the unpacked extension into the `addon/` directory.

## Install in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `addon/` folder.
4. Click the VBerry/Sidebery toolbar icon (or press `Ctrl+E` / `MacCtrl+E`) to open the Side Panel.

## Install in Vivaldi

1. Open `vivaldi://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `addon/` folder.
2. Copy the extension ID shown on the extension card (e.g. `gnjjocgkkenepghkaeghjoaepfcmjlnp`).
3. Click the `+` button in Vivaldi's Panel sidebar to add a **Web Panel** with URL:
   ```
   chrome-extension://<your-extension-id>/sidepanel.html
   ```
4. *(Optional)* Right-click the Web Panel icon → **Show Mobile Version / Desktop Version** as preferred, and use Vivaldi's Panel toggle (`F4`) or toolbar button to show/hide VBerry.

## Optional: Cleaner UI in Vivaldi (`vivaldi css hacks/`)

The [`vivaldi css hacks/`](./vivaldi%20css%20hacks) folder contains optional Vivaldi Custom UI CSS mods that strip Vivaldi's extra panel chrome so VBerry looks like a native full-height sidebar:

- `hide-panel-switch.css` — Hides Vivaldi's vertical panel icon strip (`#switch`) and removes the reserved `41px` gap when the panel is open, while collapsing the container completely when closed.
- `hide-webpanel-header.css` — Hides the Web Panel top toolbar (URL title, Back/Forward/Reload/Home, Close) so VBerry fills the full panel height.
- `hide-window-borders.css` — Removes the borders, margins, padding, and rounded-corner frame around `#webview-container` / `#webpage-stack` on the right and bottom of the window.

### How to enable the Vivaldi CSS mods

1. Open `vivaldi://experiments` and enable **Allow for using CSS modifications**.
2. Open **Settings → Appearance → Custom UI Modifications**.
3. Click **Select Folder...** and choose the `vivaldi css hacks/` folder.
4. Restart Vivaldi.

## Credits

Forked from [mbnuqw/sidebery](https://github.com/mbnuqw/sidebery).
