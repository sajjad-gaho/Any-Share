import type { LoginInput, PasswordResetConfirmInput, RegisterInput } from '@remote-desktop/shared';
import { create } from 'zustand';
import { getDesktopApi } from '@/lib/desktop-api';
import type { AuthState, AuthUser, IpcResult, ThisDevice } from '../../../shared/ipc';

type Status = 'loading' | 'signed-out' | 'signed-in' | 'unavailable';

interface AuthStoreState {
  status: Status;
  user: AuthUser | null;
  thisDevice: ThisDevice | null;
  /** Loads the session (restoring a saved one on first launch). */
  init: () => Promise<void>;
  login: (input: LoginInput) => Promise<IpcResult>;
  register: (input: RegisterInput) => Promise<IpcResult<{ needsConfirmation: boolean }>>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<IpcResult>;
  confirmPasswordReset: (input: PasswordResetConfirmInput) => Promise<IpcResult>;
  registerThisDevice: (name: string) => Promise<IpcResult>;
}

const UNAVAILABLE: IpcResult<never> = {
  ok: false,
  error: { code: 'unavailable', message: 'Sign-in is only available in the desktop app.' },
};

/**
 * Renderer view of the session. Holds who is signed in — never tokens, which
 * stay in the main process.
 */
export const useAuthStore = create<AuthStoreState>()((set, get) => {
  async function apply(state: AuthState): Promise<void> {
    if (state.status === 'signed-in') {
      const thisDevice = (await getDesktopApi()?.thisDevice.get()) ?? null;
      set({ status: 'signed-in', user: state.user, thisDevice });
    } else {
      set({ status: 'signed-out', user: null, thisDevice: null });
    }
  }

  return {
    status: 'loading',
    user: null,
    thisDevice: null,

    async init() {
      const api = getDesktopApi();
      if (!api) {
        set({ status: 'unavailable' });
        return;
      }
      await apply(await api.auth.getState());
    },

    async login(input) {
      const api = getDesktopApi();
      if (!api) return UNAVAILABLE;
      const result = await api.auth.login(input);
      if (!result.ok) return result;
      await apply(result.value);
      return { ok: true, value: undefined };
    },

    async register(input) {
      const api = getDesktopApi();
      if (!api) return UNAVAILABLE;
      const result = await api.auth.register(input);
      if (!result.ok) return result;
      await apply(result.value.state);
      return { ok: true, value: { needsConfirmation: result.value.needsConfirmation } };
    },

    async logout() {
      await getDesktopApi()?.auth.logout();
      set({ status: 'signed-out', user: null, thisDevice: null });
    },

    async requestPasswordReset(email) {
      return (await getDesktopApi()?.auth.requestPasswordReset(email)) ?? UNAVAILABLE;
    },

    async confirmPasswordReset(input) {
      return (await getDesktopApi()?.auth.confirmPasswordReset(input)) ?? UNAVAILABLE;
    },

    async registerThisDevice(name) {
      const api = getDesktopApi();
      if (!api) return UNAVAILABLE;
      const result = await api.thisDevice.register(name);
      if (!result.ok) return result;
      if (get().status === 'signed-in') set({ thisDevice: result.value });
      return { ok: true, value: undefined };
    },
  };
});
