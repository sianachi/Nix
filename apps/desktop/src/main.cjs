'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const { isSafeExternalUrl, resolveWebUrl } = require('./config.cjs');

function createWindow(webUrl) {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'Nix',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isSafeExternalUrl(url)) {
      event.preventDefault();
    }
  });

  void window.loadURL(webUrl).catch((error) => {
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Nix could not connect',
      message: 'The Nix server could not be opened.',
      detail: error instanceof Error ? error.message : String(error),
    });
  });

  return window;
}

async function start() {
  await app.whenReady();

  let webUrl;
  try {
    webUrl = resolveWebUrl({
      args: process.argv.slice(1),
      env: process.env,
      isPackaged: app.isPackaged,
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Nix server is not configured',
      message: error instanceof Error ? error.message : String(error),
    });
    app.quit();
    return;
  }

  createWindow(webUrl);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(webUrl);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void start();
