# Local Roam-Style Notes Desktop App

A lightweight Roam Research-inspired app for **personal local use only**.

## Features

- Block-based editing
- Nested blocks (indent/outdent)
- `[[Wiki Links]]` to open/create pages
- Backlinks panel
- **Global search across pages and blocks**
- **Page tags** with `#tags` (save tags per page + filter pages by tag)
- **Daily note auto-template** for new date pages (e.g., `YYYY-MM-DD`)
- Daily note page shortcut
- JSON export/import backup
- **Desktop file storage** (Electron app data file)

## Tech

- Electron
- HTML/CSS/JavaScript (single renderer page)

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Data storage

In desktop mode, data is saved to a local JSON file:

- Windows: `%APPDATA%/local-roam-desktop/notes-data.json` (actual resolved path is shown inside the app)

## Keyboard shortcuts

- `Enter`: create new sibling block
- `Tab`: indent block under previous sibling
- `Shift+Tab`: outdent block
- `Backspace` on empty block: delete block
- `[[Page Name]]`: create/open linked page
- `((blockId))`: embed a specific block by ID

## Tags, Search, Daily Template

- Add page tags in the editor using `#tag` format (or plain words), then click **Save Tags**.
- Use **Global Search** in the left sidebar to find matches across page titles and block text.
- Click **Open Today** to open/create a `YYYY-MM-DD` page.
  - If that daily page is new/empty, it gets a starter template automatically.
  - Existing daily pages are **not overwritten**.

## Project files

- `main.js` — Electron main process + file storage IPC
- `preload.js` — secure bridge (`window.storageAPI`)
- `index.html` — app UI + editor logic

## Notes

- Local-only (no cloud sync)
- Backup with **Export JSON** regularly
