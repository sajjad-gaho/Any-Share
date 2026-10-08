import { useEffect } from 'react';
import { getDesktopApi } from '@/lib/desktop-api';
import { resolveTheme, useThemeStore } from '@/stores/theme-store';

/**
 * Applies the theme preference to <html> and keeps the native window chrome
 * in sync via the main process. "System" follows OS changes live.
 */
export function useThemeSync(): void {
  const preference = useThemeStore((state) => state.preference);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = resolveTheme(preference, media.matches);
      const root = document.documentElement;
      root.classList.toggle('dark', resolved === 'dark');
      root.style.colorScheme = resolved;
    };

    apply();
    media.addEventListener('change', apply);
    getDesktopApi()
      ?.theme.setSource(preference)
      .catch((error: unknown) => console.error('Failed to sync native theme', error));

    return () => media.removeEventListener('change', apply);
  }, [preference]);
}
