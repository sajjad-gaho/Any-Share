import { displayNameSchema } from '@remote-desktop/shared';
import { QUALITY_PRESETS, type QualityPreset } from '@remote-desktop/webrtc';
import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { validatedMerge } from '@/lib/persist';

/**
 * Local, per-device preferences that genuinely work.
 * Settings for features that do not exist yet are NOT stored here; they are
 * rendered as disabled "planned" controls (see pages/settings/sections.ts).
 */
/** What the connect form asks for by default. The remote side still decides. */
export interface ConnectDefaults {
  control: boolean;
  clipboard: boolean;
  fileTransfer: boolean;
}

interface SettingsData {
  showSampleData: boolean;
  displayName: string | null;
  connectDefaults: ConnectDefaults;
  /** Quality preset a new session starts with; it can still be changed in the session. */
  defaultQuality: QualityPreset;
}

interface SettingsState extends SettingsData {
  setShowSampleData: (enabled: boolean) => void;
  setDisplayName: (displayName: string | null) => void;
  setConnectDefault: (key: keyof ConnectDefaults, enabled: boolean) => void;
  setDefaultQuality: (preset: QualityPreset) => void;
}

const persistedSchema = z
  .object({
    showSampleData: z.boolean(),
    displayName: displayNameSchema.nullable(),
    connectDefaults: z.object({
      control: z.boolean(),
      clipboard: z.boolean(),
      fileTransfer: z.boolean(),
    }),
    defaultQuality: z.enum(QUALITY_PRESETS),
  })
  .partial();

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // Example devices help while developing the UI, but in a built app they
      // would look like real machines: off by default outside the dev server.
      showSampleData: import.meta.env.DEV,
      displayName: null,
      connectDefaults: { control: true, clipboard: true, fileTransfer: false },
      defaultQuality: 'auto',
      setShowSampleData: (showSampleData) => set({ showSampleData }),
      setDisplayName: (displayName) => set({ displayName }),
      setConnectDefault: (key, enabled) =>
        set((state) => ({ connectDefaults: { ...state.connectDefaults, [key]: enabled } })),
      setDefaultQuality: (defaultQuality) => set({ defaultQuality }),
    }),
    {
      name: 'kestrel.settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({
        showSampleData,
        displayName,
        connectDefaults,
        defaultQuality,
      }): SettingsData => ({ showSampleData, displayName, connectDefaults, defaultQuality }),
      merge: validatedMerge<SettingsState>(persistedSchema),
    },
  ),
);
