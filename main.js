const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const storage = require('./storage');

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
  return storage.loadData();
});

ipcMain.handle('storage:save', async (_event, data, options) => {
  return storage.saveData(data, options);
});

ipcMain.handle('storage:backup', async (_event, data, options) => {
  return storage.createUserBackup(data, options);
});

ipcMain.handle('storage:path', async () => {
  return { ok: true, path: storage.getDataFilePath() };
});

app.whenReady().then(async () => {
  await storage.ensureDataFile();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
