import { zodResolver } from '@hookform/resolvers/zod';
import { profileInputSchema, type ProfileInput } from '@remote-desktop/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  FieldError,
  Input,
  Label,
} from '@remote-desktop/ui';
import { CircleUser, LogOut } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { PageHeader } from '@/components/PageHeader';
import { AuthPanel } from '@/components/AuthPanel';
import { ThisDeviceCard } from '@/components/ThisDeviceCard';
import { useAppInfo } from '@/lib/desktop-api';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

function ProfileForm() {
  const displayName = useSettingsStore((state) => state.displayName);
  const setDisplayName = useSettingsStore((state) => state.setDisplayName);
  const [saved, setSaved] = useState(false);
  const inputId = useId();
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
  } = useForm<ProfileInput>({
    resolver: zodResolver(profileInputSchema),
    defaultValues: { displayName: displayName ?? '' },
  });

  const onSubmit = handleSubmit((values) => {
    setDisplayName(values.displayName);
    reset(values);
    setSaved(true);
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <CardContent className="space-y-1.5">
        <Label htmlFor={inputId}>Display name</Label>
        <Input
          id={inputId}
          className="max-w-sm"
          autoComplete="name"
          aria-invalid={Boolean(errors.displayName)}
          {...register('displayName', { onChange: () => setSaved(false) })}
        />
        <FieldError>{errors.displayName?.message}</FieldError>
        <p className="text-xs text-muted-foreground">Stored on this computer only.</p>
      </CardContent>
      <CardFooter>
        <Button type="submit" disabled={!isDirty}>
          Save
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {saved ? 'Saved' : ''}
        </p>
      </CardFooter>
    </form>
  );
}

function AccountCard() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{user ? 'Account' : 'Sign in'}</CardTitle>
        <CardDescription>
          {user
            ? 'Signed in. Your session is restored automatically next time.'
            : 'Sign in to see your devices and sessions and to register this device.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status === 'loading' ? (
          <p className="text-sm text-muted-foreground">Checking your session…</p>
        ) : status === 'unavailable' ? (
          <p className="text-sm text-muted-foreground">
            Sign-in is only available in the desktop app.
          </p>
        ) : user ? (
          <div className="flex flex-wrap items-center gap-4">
            <CircleUser className="size-10 text-muted-foreground" aria-hidden="true" />
            <div className="flex-1">
              <p className="font-medium">{user.displayName ?? user.email}</p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
              {user.memberships.length > 0 ? (
                <ul className="mt-1 text-sm text-muted-foreground">
                  {user.memberships.map((m) => (
                    <li key={m.organizationId}>
                      {m.organizationName} · <span className="capitalize">{m.role}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Button variant="outline" onClick={() => void logout()}>
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </div>
        ) : (
          <AuthPanel />
        )}
      </CardContent>
    </Card>
  );
}

export function AccountPage() {
  const appInfo = useAppInfo();

  return (
    <>
      <PageHeader title="Account" description="Your identity and information about this app." />

      <AccountCard />

      <ThisDeviceCard />

      <Card>
        <CardHeader>
          <CardTitle>Local profile</CardTitle>
          <CardDescription>How you are greeted in the app.</CardDescription>
        </CardHeader>
        <ProfileForm />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
          <CardDescription>Version details for support requests.</CardDescription>
        </CardHeader>
        <CardContent>
          {appInfo ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Application</dt>
              <dd>
                {appInfo.name} {appInfo.version}
                {appInfo.isPackaged ? '' : ' (development)'}
              </dd>
              <dt className="text-muted-foreground">Platform</dt>
              <dd>{appInfo.platform}</dd>
              <dt className="text-muted-foreground">Electron</dt>
              <dd className="font-mono">{appInfo.versions.electron}</dd>
              <dt className="text-muted-foreground">Chromium</dt>
              <dd className="font-mono">{appInfo.versions.chrome}</dd>
              <dt className="text-muted-foreground">Node.js</dt>
              <dd className="font-mono">{appInfo.versions.node}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Version information is unavailable.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
