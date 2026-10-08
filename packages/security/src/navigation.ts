/**
 * Decides whether an Electron window may navigate to `target`.
 *
 * The app is a single-page application, so legitimate navigation only ever
 * stays on the renderer's own origin (the Vite dev server in development, or
 * the packaged index.html file in production). Everything else is denied.
 *
 * @param target       URL the window is trying to load.
 * @param rendererUrl  URL the window was originally created with.
 */
export function isAllowedNavigation(target: string, rendererUrl: string): boolean {
  let targetUrl: URL;
  let allowedUrl: URL;
  try {
    targetUrl = new URL(target);
    allowedUrl = new URL(rendererUrl);
  } catch {
    return false;
  }

  if (allowedUrl.protocol === 'file:') {
    // Same file, any hash route (HashRouter). Never another file on disk, and
    // never a file:// URL with a host (UNC, \\server\share), which would make
    // Windows contact that server and offer the user's NTLM credentials.
    return (
      targetUrl.protocol === 'file:' &&
      targetUrl.host === allowedUrl.host &&
      targetUrl.pathname === allowedUrl.pathname
    );
  }

  if (allowedUrl.protocol === 'http:' || allowedUrl.protocol === 'https:') {
    return targetUrl.origin === allowedUrl.origin;
  }

  return false;
}

/** Only these schemes may be handed to the OS (e.g. "open link in browser"). */
const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:']);

export function isSafeExternalUrl(target: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(target).protocol);
  } catch {
    return false;
  }
}
