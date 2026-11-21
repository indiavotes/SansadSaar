# SansadSaar — persistence

What this app stores in your browser, where it stores it, and why some keys
still read `sansadlocal` even though the product is now SansadSaar.

> **TL;DR:** persistence keys are deliberately preserved at their legacy
> SansadLocal names so an existing user's data — summaries, chats, cached
> texts, settings — carries over silently after the rename. None of these
> keys will be migrated. Future SansadSaar features add **new** stores /
> keys; existing ones stay where they are.

## Inventory

### IndexedDB

Database name: **`sansadlocal`** (legacy — never renamed). Version 2.

| Store       | Key shape                                | Value         | Purpose                                  |
|-------------|------------------------------------------|---------------|------------------------------------------|
| `summaries` | `<committee>\|<lok_sabha>\|<report_num>` | string        | AI-generated per-report summaries.       |
| `texts`     | `<committee>\|<lok_sabha>\|<report_num>` | string        | Extracted PDF text for opened reports.   |
| `chats`     | `<committee>\|<lok_sabha>\|<report_num>` | message array | Per-report Q&A threads (Ask tab).        |
| `blobs`     | `'reports.json'` / `'manifest.json'` / `'meta.json'` | parsed JSON | Mirror snapshots so the app loads offline. |

DB version 2 added the `chats` store on top of v1's three stores. The
`onupgradeneeded` handler is idempotent — old DBs auto-upgrade by creating
just the missing store.

The store keys above are **DRSC-specific** (committee + Lok Sabha + report
number tuple). When v1.0b adds CAG, CAG will use **new stores** under the
same DB — `cag_summaries`, `cag_texts`, `cag_chats`, `cag_blobs` — keyed by
CAG's own primary unit. The original four stores stay untouched. No rename,
no migration.

### localStorage

| Key                          | Value                                  | Owner | Purpose                                     |
|------------------------------|----------------------------------------|-------|---------------------------------------------|
| `sansadlocal.settings.v1`    | JSON: `{aiMode, localModel, apiProvider, apiKey, apiModel, apiBaseUrl, searchProvider, searchApiKey, searchBaseUrl, deepSearch}` | shell + corpora | Settings panel state. Single blob shared across modules. |
| `sansadlocal.introSeen`      | `'1'` flag                             | shell | First-visit help-modal-auto-opens flag.    |

### Cache Storage (Service Worker–style edge cache)

Hugging Face's Transformers.js writes model weights here on first load.
Cleared via Settings → Local AI → "Clear cache".

## Why preserve `sansadlocal` names?

1. **Existing user data.** Users who installed SansadLocal have summaries,
   chats, settings, model weights all stored under these keys. Renaming would
   mean either migrating (risky — lots of code, lots of edge cases) or
   discarding (cruel — some users have generated dozens of summaries that
   would silently vanish on rename).
2. **No UX cost.** The keys are only visible in DevTools. The user guide
   §11 calls out the legacy name parenthetically so a fresh user isn't
   confused on first inspection.
3. **No technical cost.** The DB / key naming is internal; nothing about
   them constrains future SansadSaar features.

## What rename will *never* happen

- IndexedDB `sansadlocal` → never renamed.
- localStorage `sansadlocal.*` → never renamed.

If we ever did want to rebrand the persistence (we don't plan to), it would
require a versioned migration: open old DB, copy stores into new DB
`sansadsaar`, verify counts, drop old. Not worth the risk for cosmetics.

## Origin scoping

**Storage is per-origin.** SansadSaar serves on two custom domains:

- `https://www.indiavotes.com/sansadsaar` (canonical)
- `https://sansadlocal.naklitechie.com` (alias)

These are **different origins for storage purposes**. A user with summaries
on `sansadlocal.naklitechie.com` who navigates to `www.indiavotes.com/sansadsaar`
lands on a cold install — no summaries, no settings, no model cache.

This is accepted by spec (`plan/sansadsaar-spec-001-v0.4.md` §"Notes on dual
app URLs"). Both URLs work fully; we just don't promote cross-URL switching.
sansadlocal users keep using sansadlocal; new users land on sansadsaar.

## Module ownership

After the v1.0a phase 1 corpus-module refactor:

- **`app/deps.js`** — owns the IDB primitives (`openIDB`, `idbGet`, `idbPut`,
  `idbCursor`) and the localStorage settings IO (`loadSettings`, `saveSettings`).
  Re-exports key constants.
- **`app/shell.js`** — owns the shell-level keys in the settings JSON
  (`aiMode`, `localModel`, `apiProvider`, `apiKey`, `apiModel`, `apiBaseUrl`,
  `searchProvider`, `searchApiKey`, `searchBaseUrl`).
- **`app/corpora/drsc/index.js`** — owns DRSC-specific keys (`deepSearch`)
  and all four IDB stores.

Each module reads / writes the legacy single localStorage blob
(`sansadlocal.settings.v1`); modules don't touch each other's keys.
