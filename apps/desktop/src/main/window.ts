import { join } from 'node:path';
import { BRAND } from '@remote-desktop/shared';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { getRendererUrl } from './renderer-url';

const BACKGROUND = { light: '#f7f8fa', dark: '#16181d' } as const;

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: BRAND.productName,
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      // Security baseline. Do not relax these; add narrow IPC methods instead.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // DevTools only in development builds.
      devTools: !app.isPackaged,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());

  void window.loadURL(getRendererUrl());
  return window;
}
