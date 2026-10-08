import { TooltipProvider } from '@remote-desktop/ui';
import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { devicesStore, sessionsStore } from '@/stores/app-stores';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { router } from './router';
import { useThemeSync } from './useThemeSync';

/** Reloads already-loaded collections when the data source (sample data, account) changes. */
function useDataSourceSync(): void {
  const showSampleData = useSettingsStore((state) => state.showSampleData);
  const authStatus = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.user?.id);
  useEffect(() => {
    for (const store of [devicesStore, sessionsStore] as const) {
      if (store.getState().status !== 'idle') void store.getState().load();
    }
  }, [showSampleData, authStatus, userId]);
}

/** Restores a saved session (held by the main process) on launch. */
function useAuthInit(): void {
  useEffect(() => {
    void useAuthStore.getState().init();
  }, []);
}

export function App() {
  useThemeSync();
  useAuthInit();
  useDataSourceSync();

  return (
    <TooltipProvider delayDuration={300}>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
