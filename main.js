const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const DATA_FILE = 'notes-data.json';
const CUSTOM_DATA_DIR = 'C:\\Users\\viky1\\Downloads\\notes_roam';

function getDataFilePath() {
  return path.join(CUSTOM_DATA_DIR, DATA_FILE);
}

async function ensureDataFile() {
  const filePath = getDataFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(null), 'utf8');
  }
  return filePath;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;

    const key = input.key;
    const code = input.code;
    const zoomFactor = win.webContents.getZoomFactor();
    const setZoomFactor = (next) => {
      event.preventDefault();
      win.webContents.setZoomFactor(Math.max(0.5, Math.min(2, next)));
    };

    if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') {
      setZoomFactor(zoomFactor - 0.1);
      return;
    }

    if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') {
      setZoomFactor(zoomFactor + 0.1);
      return;
    }

    if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
      setZoomFactor(1);
    }
  });
}

ipcMain.handle('storage:load', async () => {
  const filePath = await ensureDataFile();
  try {
    const text = await fs.readFile(filePath, 'utf8');
    if (!text || text.trim() === '' || text.trim() === 'null') {
      return { ok: true, data: null };
    }
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('storage:save', async (_event, data) => {
  const filePath = await ensureDataFile();
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('storage:path', async () => {
  return { ok: true, path: getDataFilePath() };
});

app.whenReady().then(async () => {
  await ensureDataFile();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
