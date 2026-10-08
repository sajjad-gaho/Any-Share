import { useEffect, useState } from 'react';
import type { AppInfo, DesktopApi } from '../../../shared/ipc';

/** The preload bridge, or undefined when running outside Electron (tests, plain browser). */
export function getDesktopApi(): DesktopApi | undefined {
  return window.desktop;
}

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDesktopApi()
      ?.app.getInfo()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((error: unknown) => console.error('Failed to read app info', error));
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
