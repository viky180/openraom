# Graph Notes Mobile PWA

Standalone mobile PWA for imported Roam-style notes JSON. This app is separate from the Electron/desktop app in the parent folder.

## What It Does

- Imports the desktop app JSON export shape: `{ "pages": { ... } }`
- Imports Roam JSON export arrays with page `title` and block `children`
- Stores notes locally on the phone with IndexedDB, falling back to localStorage
- Works offline after the first successful load through `service-worker.js`
- Exports the current mobile notes back to JSON

## Local Test

From the repo root:

```bash
npm run web
```

Open:

```text
http://127.0.0.1:3100/mobile-pwa/index.html
```

## Mobile Install

Mobile PWA installation and offline service workers require HTTPS, except on `localhost`.

This repo includes a GitHub Pages workflow at `.github/workflows/pages.yml` that publishes only this `mobile-pwa` folder to the `gh-pages` branch.

In GitHub, set **Settings > Pages** to:

- Source: **Deploy from a branch**
- Branch: **gh-pages**
- Folder: **/(root)**

After the workflow finishes, open:

```text
https://viky180.github.io/openraom/
```

Then use Android Chrome's **Add to Home screen** / **Install app** action.

## Data Notes

- The desktop app data is not automatically shared with this mobile app.
- Import JSON on the phone to load your notes.
- Export JSON from the mobile app whenever you want a portable backup.
