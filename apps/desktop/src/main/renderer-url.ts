import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';

/**
 * The single URL the renderer is allowed to live on.
 * Development: the electron-vite dev server. Production: the bundled index.html.
 */
export function getRendererUrl(): string {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devServerUrl) return devServerUrl;
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
}
