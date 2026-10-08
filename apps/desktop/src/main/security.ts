import { isAllowedNavigation, isSafeExternalUrl } from '@remote-desktop/security';
import { app, session, shell, type WebContents } from 'electron';

export interface SecurityHooks {
  /** True only for the window of an active host session that may capture the screen. */
  isCaptureAllowed(contents: WebContents | null): boolean;
}

/** Granted only to host-session windows, and only while their session allows screen view. */
const CAPTURE_PERMISSIONS = new Set(['media', 'display-capture']);
import { getRendererUrl } from './renderer-url';

/** Browser permissions the renderer may use. Everything else (camera, mic, geolocation, ...) is denied. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function hardenWebContents(contents: WebContents): void {
  const rendererUrl = getRendererUrl();

  // Block navigation away from the app (e.g. a dropped file or a malicious link).
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, rendererUrl)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, rendererUrl)) event.preventDefault();
  });

  // Never open new Electron windows from content. Safe external links go to the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // <webview> is disabled via webPreferences; refuse attachment as defence in depth.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function applyAppSecurityPolicies(hooks: SecurityHooks): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

  void app.whenReady().then(() => {
    const defaultSession = session.defaultSession;

    defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (CAPTURE_PERMISSIONS.has(permission)) {
        callback(hooks.isCaptureAllowed(webContents));
        return;
      }
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    defaultSession.setPermissionCheckHandler((webContents, permission) =>
      CAPTURE_PERMISSIONS.has(permission)
        ? hooks.isCaptureAllowed(webContents)
        : ALLOWED_PERMISSIONS.has(permission),
    );
    // No devices (HID, serial, USB) are exposed to the renderer.
    defaultSession.setDevicePermissionHandler(() => false);
  });
}
