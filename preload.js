const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storageAPI', {
  load: () => ipcRenderer.invoke('storage:load'),
  save: (data) => ipcRenderer.invoke('storage:save', data),
  path: () => ipcRenderer.invoke('storage:path')
});
