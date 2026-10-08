import { displayNameSchema } from '@remote-desktop/shared';
import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { validatedMerge } from '@/lib/persist';

/**
 * Local, per-device preferences that genuinely work in Phase 1.
 * Settings for features that do not exist yet are NOT stored here; they are
 * rendered as disabled "planned" controls (see pages/settings/sections.ts).
 */
interface SettingsData {
  showSampleData: boolean;
  displayName: string | null;
}

interface SettingsState extends SettingsData {
  setShowSampleData: (enabled: boolean) => void;
  setDisplayName: (displayName: string | null) => void;
}

const persistedSchema = z
  .object({ showSampleData: z.boolean(), displayName: displayNameSchema.nullable() })
  .partial();

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // Example devices help while developing the UI, but in a built app they
      // would look like real machines: off by default outside the dev server.
      showSampleData: import.meta.env.DEV,
      displayName: null,
      setShowSampleData: (showSampleData) => set({ showSampleData }),
      setDisplayName: (displayName) => set({ displayName }),
    }),
    {
      name: 'kestrel.settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ showSampleData, displayName }): SettingsData => ({
        showSampleData,
        displayName,
      }),
      merge: validatedMerge<SettingsState>(persistedSchema),
    },
  ),
);
