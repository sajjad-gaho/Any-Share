import { Badge, Button, Input, Label, Switch } from '@remote-desktop/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { getDesktopApi } from '@/lib/desktop-api';
import { useAuthStore } from '@/stores/auth-store';
import type { ThisDeviceSettings, ThisDeviceSettingsUpdate } from '../../../../shared/ipc';
import { SettingRow } from './SettingRow';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

/** A row-shaped note for states where the server-backed settings cannot be shown. */
function Notice({ children, role }: { children: string; role?: 'alert' }) {
  return (
    <p role={role} className="px-5 py-4 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function PasswordForm({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const passwordId = useId();
  const confirmId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setProblem(`Use at least ${MIN_PASSWORD} characters.`);
    } else if (password !== confirm) {
      setProblem('The passwords do not match.');
    } else {
      setProblem(null);
      onSave(password);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 px-5 pb-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={passwordId}>New access password</Label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            maxLength={MAX_PASSWORD}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={confirmId}>Confirm password</Label>
          <Input
            id={confirmId}
            type="password"
            autoComplete="new-password"
            maxLength={MAX_PASSWORD}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
      </div>
      <p role="alert" className="min-h-5 text-sm text-destructive">
        {problem ?? ''}
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * This computer's approval and access-password settings. They live on the
 * server (the device record), so they apply wherever the device is used and
 * are enforced there, not in this app.
 */
export function SecuritySettings() {
  const signedIn = useAuthStore((state) => state.status === 'signed-in');
  const thisDevice = useAuthStore((state) => state.thisDevice);
  const [security, setSecurity] = useState<ThisDeviceSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);

  const load = useCallback(async () => {
    const api = getDesktopApi();
    if (!api) return;
    setLoadError(null);
    const result = await api.thisDevice.getSettings();
    if (result.ok) setSecurity(result.value);
    else setLoadError(result.error.message);
  }, []);

  useEffect(() => {
    if (signedIn && thisDevice) void load();
  }, [signedIn, thisDevice, load]);

  const save = async (update: ThisDeviceSettingsUpdate, message: string) => {
    const api = getDesktopApi();
    if (!api) return false;
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const result = await api.thisDevice.updateSettings(update);
      if (!result.ok) {
        setSaveError(result.error.message);
        return false;
      }
      setSecurity(result.value);
      setSaved(message);
      return true;
    } finally {
      setBusy(false);
    }
  };

  if (!getDesktopApi()) return <Notice>Available in the desktop app.</Notice>;
  if (!signedIn) return <Notice>Sign in to manage who can connect to this computer.</Notice>;
  if (!thisDevice) {
    return <Notice>Register this computer on the dashboard first.</Notice>;
  }
  if (loadError) {
    return (
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!security) {
    return (
      <p role="status" className="px-5 py-4 text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }

  return (
    <>
      <SettingRow
        label="Always ask before accepting a session"
        description="When on, someone at this computer must accept every connection from another account (for example a team member). Your own account never needs approval."
        control={({ controlId, descriptionId }) => (
          <Switch
            id={controlId}
            aria-describedby={descriptionId}
            checked={security.requireApproval}
            disabled={busy}
            onCheckedChange={(checked) =>
              void save(
                { requireApproval: checked },
                checked ? 'Connections now need approval.' : 'Connections no longer need approval.',
              )
            }
          />
        )}
      />
      <div>
        <SettingRow
          label="Access password"
          description="Anyone other than you must enter this password to connect. Together with turning off the approval prompt above, this allows unattended access."
          badge={
            <Badge variant={security.hasAccessPassword ? 'success' : 'outline'}>
              {security.hasAccessPassword ? 'Set' : 'Not set'}
            </Badge>
          }
          control={({ controlId, descriptionId }) =>
            editingPassword ? null : (
              <div className="flex gap-2">
                <Button
                  id={controlId}
                  aria-describedby={descriptionId}
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingPassword(true)}
                >
                  {security.hasAccessPassword ? 'Change' : 'Set password'}
                </Button>
                {security.hasAccessPassword ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void save({ accessPassword: null }, 'Access password removed.')}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            )
          }
        />
        {editingPassword ? (
          <PasswordForm
            busy={busy}
            onCancel={() => setEditingPassword(false)}
            onSave={(password) =>
              void save({ accessPassword: password }, 'Access password saved.').then((ok) => {
                if (ok) setEditingPassword(false);
              })
            }
          />
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="px-5 py-3 text-sm">
        {saveError ? <span className="text-destructive">{saveError}</span> : (saved ?? '')}
      </p>
    </>
  );
}
