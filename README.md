# Lorebook Atlas

A SillyTavern extension for working with large lorebooks: images on World Info entries,
nested lists for navigation, and an archive for backup and transfer.

No server plugin required — everything lives in SillyTavern's own per-user file storage.

## Features

- **Images on entries.** Attach a picture to any World Info entry. Identical files are
  stored once and reused.
- **Lists.** Group entries into nested lists; an entry can belong to several at once.
  SillyTavern's own entry list can then be filtered down to one list, which is what makes
  a lorebook of a few hundred entries workable.
- **Gallery.** Browse stored images grouped by lorebook, with locks to protect individual
  images from bulk deletion.
- **Archive.** Export everything, or a single lorebook with its images, as one `.zip`.
  Restoring shows a per-lorebook preview: create, replace, merge, or bring in separately.

## Requirements

SillyTavern **1.18.0** or newer.

## Installation

**Extensions → Install extension**, then paste the repository URL.

Or clone manually into `data/<user-handle>/extensions/third-party/`.

## Slash commands

| Command | Action |
|---|---|
| `/lba-gallery` | Open the image gallery |
| `/lba-explorer` | Open the lorebook explorer |
| `/lba-export` | Export everything to an archive |
| `/lba-import` | Restore from an archive |
| `/lba-verify` | Check the catalogue against stored files |
| `/lba-sync` | Re-sync groups with the current lorebooks |

## Languages

English and Russian. To add a locale, drop `i18n/<locale>.json` next to the existing one
and list it in `manifest.json`; `src/i18n.js` holds every string in English.

## Known limitation

Deleting the extension triggers cleanup of its stored files, but SillyTavern gives any
extension hook only five seconds and the file API deletes one file per request. With a
large library some files may survive. Reinstalling finishes the job; the **Clean extension
data** button in the extensions list does it properly at any time.

## Development

```
node --test test/*.test.js
```

No dependencies, no build step.

## License

MIT
