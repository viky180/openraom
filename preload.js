const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storageAPI', {
  load: () => ipcRenderer.invoke('storage:load'),
  save: (data, options) => ipcRenderer.invoke('storage:save', data, options),
  backup: (data, options) => ipcRenderer.invoke('storage:backup', data, options),
  path: () => ipcRenderer.invoke('storage:path')
});
