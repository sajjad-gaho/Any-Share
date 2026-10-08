import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { THEME_SOURCES, type ThemeSource } from '../../../shared/ipc';
import { validatedMerge } from '@/lib/persist';

export type ThemePreference = ThemeSource;
export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

const persistedSchema = z.object({ preference: z.enum(THEME_SOURCES) }).partial();

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: 'system',
      setPreference: (preference) => set({ preference }),
    }),
    {
      name: 'kestrel.theme',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ preference }) => ({ preference }),
      merge: validatedMerge<ThemeState>(persistedSchema),
    },
  ),
);
