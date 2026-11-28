# VBerry Privacy Policy

**Last updated:** November 27, 2026

## No User Data Collection Attestation

**VBerry does not collect, transmit, sell, rent, or share any personal data or browsing data.**

- VBerry has **no backend servers**, **no analytics**, **no telemetry**, **no advertising SDKs**, and **no third-party trackers**.
- VBerry does **not** load or execute remote code.
- All extension functionality runs **100% locally** inside your browser.

## How Data Is Handled Locally

To provide its tab management, Quick Search, bookmark, history, and snapshot features, VBerry accesses browser data strictly on your device using standard Chrome/Chromium WebExtension APIs:

- **Open tabs, Tab Groups, bookmarks, browsing history, and recently closed sessions** (`tabs`, `tabGroups`, `bookmarks`, `history`, `sessions`, `favicon`): Read and displayed locally inside the VBerry Side Panel, Quick Search popup, and omnibox suggestions so you can organize, search, and restore your own tabs and bookmarks. This data never leaves your browser through VBerry.
- **Local storage** (`storage`, `unlimitedStorage`): Preferences, custom themes, saved groups & URL rules, session tab-tree state, and tab snapshots are stored locally in your browser profile (`chrome.storage.local` and `chrome.storage.session`).
- **Optional browser-native Account Sync** (`chrome.storage.sync`): If you keep Account Sync enabled in VBerry Preferences, your preferences, custom themes, saved groups, and compressed snapshots are written only to your browser's built-in `chrome.storage.sync` storage area—managed directly by your **Google Account** (in Google Chrome) or **Vivaldi Account** (in Vivaldi, end-to-end encrypted). VBerry's developer has no access to this data. You can disable sync per device anytime in **VBerry Preferences → Account sync**.
- **Export / Import**: Manual JSON and Markdown backups are written directly to files on your computer only when you explicitly click Export.

## Chrome Web Store Limited Use Disclosure

VBerry's use of information received from Chrome/Chromium APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Because VBerry collects zero user data and transmits nothing to external servers, no user data is ever transferred to third parties.

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/justinallahyari/VBerry/issues
