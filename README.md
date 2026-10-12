# Tab Echo

[中文说明](README.zh.md)

Tab Echo is a local-first Chrome extension for finding and reopening real closed-tab events. It keeps regular and incognito browsing contexts isolated, preserves tabs closed together as an ordered Group entry, and provides a compact popup plus a full management page. It is an enhanced reopen-closed-tabs tool, not a full browser-history manager.

## Features

- Captures closed tabs in regular and incognito windows without exposing one context to the other.
- Stores every ordinary tab close immediately as its own entry; only closing a whole window creates one ordered Group entry.
- Searches titles and web addresses; a Group search shows the exact matching tabs while preserving the complete Group snapshot.
- Unfiltered summaries count every stored record, including Groups and single-tab entries hidden by display deduplication. The unfiltered popup uses an uncounted **Open full list** link; only searches show a counted **View all results** link.
- Reopens a single tab or an entire Group. Reopening never consumes the closed-tab entry.
- Excludes selected domains (including their subdomains) from future closed-tab capture. When new rules match existing data, the Save flow previews the impact and lets the user either keep those records or remove the matches immediately.
- Moves individual entries, current search results, or all entries to Trash in the same browsing context. Trash entries can be moved back without opening their pages, or removed immediately with no recovery.
- Provides a full-page dashboard for closed tabs, Trash, pagination, search, and settings. Closed tabs can be viewed by close time or domain; domain-view bulk actions affect only the selected domain.
- Shows a configurable number of results in the popup (10 by default, 1–200) for quick search and actions.
- Supports light, dark, and system themes, plus English and Chinese UI.
- Shows separate storage pressure for regular IndexedDB records and local incognito/settings data, without combining their unrelated quotas.
- Applies mixed cleanup: retention age first, then the oldest entries above the count limit; expired Trash is removed by age only.

## Retention Defaults

- Maximum closed-tab entries per browsing context: **10,000**. A Group counts as one entry.
- Closed-tab retention: **unlimited** (kept indefinitely).
- Trash retention: **3 days**, with no quantity limit.

Each retention setting can be left blank. A blank entry limit means unlimited; a blank history or Trash retention period means kept indefinitely. Browser storage limits still apply, and the extension intentionally does not request `unlimitedStorage`. Values must otherwise be positive integers. Before saving, Tab Echo previews the permanent-deletion impact; settings with no deletion impact save immediately, while destructive changes require inline confirmation.

Excluded domains are entered one per line. `example.com` matches both that hostname and its subdomains. New exclusions always apply to future closed tabs. When saving a newly added rule that matches existing data, the same inline preview offers **Save rules only** or **Save and remove matches**. Removing matches applies only to the newly added rules in the current regular or incognito context, preserves nonmatching tabs in a Group, and does not move removed data to Trash.

## Install and Use

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository's `extension/` directory.
4. Close a tab, then open Tab Echo from the toolbar. The popup shows the configured number of recent or matching entries.
5. Use **Reopen** for one tab or **Reopen all** for a Group. Use **Move to Trash** for recoverable deletion, or **Remove now** to remove the closed record immediately with no recovery.
6. Open the full page from the popup to browse all entries, manage Trash, or change settings.

Moving entries to Trash, moving them back to Closed tabs, and immediately removing one History or Trash entry do not ask for confirmation. In the popup, **Move to Trash (X)** affects only the shown entries; the **Remove now** menu can target either the shown entries or every result in the current scope. Bulk removal, destructive setting changes, and **Empty Trash** use an inline second step that states the affected records and tabs; no browser-native confirmation dialog is used.

### Incognito windows

On `chrome://extensions`, open Tab Echo's details and enable **Allow in Incognito**. The manifest uses `"incognito": "split"`, so Chrome runs a separate extension context for incognito windows. Closed-tab history and Trash remain isolated; preferences are shared. Large regular-context lists use IndexedDB; incognito records use context-isolated durable local storage so Chrome cannot discard them together with the incognito IndexedDB partition when the final incognito window closes.

## Privacy and Permissions

All data stays in browser-local storage: regular records use IndexedDB, while incognito records and shared settings use `chrome.storage.local`. Tab Echo stores only closed-event metadata such as title, web address, favicon address, timestamps, ordering, and Group metadata. It does not collect page content, form state, scroll position, unrelated browsing history, or cross-device data.

The manifest permissions are deliberately limited:

- `storage`: persist settings, closed-tab entries, Trash, and close-tracker state locally.
- `tabs`: observe tab lifecycle and reopen saved tabs.
- `alarms`: run daily retention cleanup even when no UI is open.

## Project Structure

```text
.
├── extension/
│   ├── background.js                 # MV3 worker, events, alarms, message protocol
│   ├── lib/
│   │   ├── close-tracker.js          # immediate tab closes and whole-window grouping
│   │   ├── history-store.js          # pure history, search, retention, and Trash model
│   │   ├── storage-repository.js     # settings and incognito/local repository
│   │   ├── indexeddb-repository.js   # versioned IndexedDB record generations and indexes
│   │   └── indexeddb-storage-repository.js # atomic generation switching and repository contract
│   ├── dashboard.html/.css/.js       # full closed-tabs, Trash, and settings page
│   ├── popup.html/.css/.js           # compact configurable-result toolbar UI
│   └── manifest.json                 # unpacked extension entry point
├── tests/*.test.js                   # logic, adapter, UI, and documentation contracts
├── docs/adr/                          # architecture decisions
├── docs/superpowers/plans/            # implementation plan
├── docs/testing/                      # manual acceptance checklist
├── package.json                       # dependency-free test and validation commands
├── CONTEXT.md                         # domain vocabulary
├── proposal.md                        # confirmed product specification
├── README.md
├── README.zh.md
└── LICENSE
```

The extension uses plain Manifest V3 JavaScript and has no build step. Run the complete automated suite with:

```bash
npm test
```

Run JavaScript syntax, manifest, and patch checks with `npm run check`.

## License

Tab Echo is open source under the MIT License. See [LICENSE](LICENSE).
