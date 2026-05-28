'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  connect:    () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  status:     () => ipcRenderer.invoke('status'),
  quit:       () => ipcRenderer.invoke('quit'),
  hide:       () => ipcRenderer.invoke('hide'),
});
