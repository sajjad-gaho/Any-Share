import { formatDeviceId } from '@remote-desktop/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@remote-desktop/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * Shows this computer's public device ID, or lets a signed-in user register it.
 * Registration creates an Ed25519 key pair in the main process; only the
 * public key is sent to the server.
 */
export function ThisDeviceCard() {
  const status = useAuthStore((s) => s.status);
  const thisDevice = useAuthStore((s) => s.thisDevice);
  const registerThisDevice = useAuthStore((s) => s.registerThisDevice);
  const displayName = useSettingsStore((s) => s.displayName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const register = async () => {
    setBusy(true);
    setError(null);
    const result = await registerThisDevice(
      displayName ? `${displayName}'s computer` : 'This computer',
    );
    if (!result.ok) setError(result.error.message);
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>This device</CardTitle>
        <CardDescription>Share this ID so others can connect to you.</CardDescription>
      </CardHeader>
      <CardContent>
        {thisDevice ? (
          <>
            <p
              className="font-mono text-2xl tracking-wider"
              aria-label={`Device ID ${thisDevice.deviceCode}`}
            >
              {formatDeviceId(thisDevice.deviceCode)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Registered as “{thisDevice.name}”. The ID is public; access always needs approval or a
              grant.
            </p>
          </>
        ) : (
          <>
            <p
              className="font-mono text-2xl tracking-wider text-muted-foreground"
              aria-label="Device ID not assigned"
            >
              ––– ––– –––
            </p>
            {status === 'signed-in' ? (
              <div className="mt-3 space-y-2">
                <Button size="sm" onClick={() => void register()} disabled={busy}>
                  {busy ? 'Registering…' : 'Register this device'}
                </Button>
                <p role="alert" className="text-xs text-destructive">
                  {error ?? ''}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                <Link to="/account" className="font-medium underline underline-offset-4">
                  Sign in
                </Link>{' '}
                to register this device and get an ID.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
