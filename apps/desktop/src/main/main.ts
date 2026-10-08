import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findDebugSwitch } from '@remote-desktop/security';
import { BRAND } from '@remote-desktop/shared';
import { app, BrowserWindow, Menu, session } from 'electron';
import { createBackend } from './backend';
import { registerIpcHandlers } from './ipc';
import { getRendererUrl } from './renderer-url';
import { applyAppSecurityPolicies } from './security';
import { SessionCoordinator } from './session/coordinator';
import { createMainWindow } from './window';

// Every renderer runs in a Chromium OS-level sandbox, including any created later.
app.enableSandbox();

// Packaged builds refuse to run under the DevTools protocol or the Node
// inspector: either would let another local process drive the app unseen.
// (The Electron fuses set at packaging time disable the Node-side switches too.)
const debugSwitch = app.isPackaged ? findDebugSwitch(process.argv) : null;
if (debugSwitch) {
  console.error(`Refusing to start: --${debugSwitch} is not allowed in this build.`);
  app.exit(1);
}

/**
 * Development only: `KESTREL_PROFILE=b` runs a second, fully separate instance
 * (own data folder, own single-instance lock) so two local clients can be
 * tested against each other. Ignored in packaged builds.
 */
const profile = process.env['KESTREL_PROFILE'];
if (!app.isPackaged && profile && /^[a-z0-9-]{1,20}$/.test(profile)) {
  app.setPath('userData', join(app.getPath('appData'), `kestrel-remote-dev-${profile}`));
}

/** The native helper: bundled next to the app, or the cargo build output in development. */
function helperPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kestrel-helper.exe');
  const target = resolve(__dirname, '../../../../native/windows-helper/target');
  const release = join(target, 'release', 'kestrel-helper.exe');
  return existsSync(release) ? release : join(target, 'debug', 'kestrel-helper.exe');
}

// One instance per user session: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(BRAND.productName);
  // No application menu in production: it would also bring the DevTools / reload accelerators.
  if (app.isPackaged) Menu.setApplicationMenu(null);
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.example.kestrel-remote'); // placeholder identifier
  }

  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  let coordinator: SessionCoordinator | null = null;
  applyAppSecurityPolicies({
    isCaptureAllowed: (contents) => coordinator?.isCaptureAllowed(contents) ?? false,
  });

  void app.whenReady().then(() => {
    const backend = createBackend();
    let mainWindow: BrowserWindow | null = null;
    coordinator = new SessionCoordinator({
      signalingUrl: backend.signalingUrl,
      auth: backend.auth,
      device: backend.device,
      helperPath: helperPath(),
      rendererUrl: getRendererUrl,
      preloadPath: join(__dirname, '../preload/preload.js'),
      mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    });
    const sessions = coordinator;

    // Screen capture is granted only to an active host session's window, and
    // only the source that window's session prepared (never a picker, never
    // another window's choice).
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const contents = request.frame
        ? (BrowserWindow.getAllWindows()
            .map((w) => w.webContents)
            .find(
              (wc) =>
                wc.mainFrame.processId === request.frame?.processId &&
                wc.mainFrame.routingId === request.frame.routingId,
            ) ?? null)
        : null;
      sessions.handleDisplayMediaRequest(contents, callback);
    });

    backend.auth.onChange((state) => sessions.onAuthChanged(state.status === 'signed-in'));
    void backend.auth
      .restore()
      .then((state) => sessions.onAuthChanged(state.status === 'signed-in'));

    registerIpcHandlers(backend, sessions);
    mainWindow = createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !coordinator) return;
    // End sessions cleanly (helper input released, peers notified) before exit.
    event.preventDefault();
    quitting = true;
    void coordinator.shutdown().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
