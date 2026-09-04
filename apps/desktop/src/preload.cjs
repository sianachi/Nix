'use strict';

const { contextBridge } = require('electron');

// Keep the renderer web application browser-like. This bridge is intentionally small: the web
// app does not receive filesystem, process, or Electron capabilities.
contextBridge.exposeInMainWorld('nixDesktop', Object.freeze({ platform: process.platform }));
