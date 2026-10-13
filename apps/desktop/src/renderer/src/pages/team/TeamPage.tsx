import type { OrganizationMember, OrganizationWithRole, Role } from '@remote-desktop/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  NativeSelect,
} from '@remote-desktop/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { getDesktopApi } from '@/lib/desktop-api';
import { devicesStore } from '@/stores/app-stores';
import { useAuthStore } from '@/stores/auth-store';
import type { IpcResult, ThisDeviceSettings } from '../../../../shared/ipc';

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  user: 'User',
};

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control of the team. Can connect to and add computers.',
  admin: 'Manages operators and users. Can connect to and add computers.',
  operator: 'Can connect to team computers (no file transfer). Cannot add computers.',
  user: 'Member only. Cannot connect to team computers.',
};

/** Mirrors the server rule (packages/security rbac canManageMember); the server decides. */
function canManage(actor: Role, current: Role | null, target: Role | null): boolean {
  if (actor === 'owner') return true;
  if (actor !== 'admin') return false;
  const manageable: Role[] = ['operator', 'user'];
  return (
    (current === null || manageable.includes(current)) &&
    (target === null || manageable.includes(target))
  );
}

function assignableRoles(actor: Role): Role[] {
  return (['owner', 'admin', 'operator', 'user'] as const).filter((role) =>
    canManage(actor, null, role),
  );
}

/** Team names become URL-safe slugs; a random suffix keeps them unique. */
function slugFor(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'team';
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

function Message({ error, text }: { error: string | null; text: string | null }) {
  return (
    <p role="status" aria-live="polite" className="min-h-5 text-sm">
      {error ? <span className="text-destructive">{error}</span> : (text ?? '')}
    </p>
  );
}

function CreateTeamForm({ onCreated }: { onCreated: (team: OrganizationWithRole) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const api = getDesktopApi();
    const trimmed = name.trim();
    if (!api || !trimmed) return;
    setBusy(true);
    setError(null);
    const result = await api.teams.create({ name: trimmed, slug: slugFor(trimmed) });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setName('');
    onCreated(result.value);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Team name</Label>
        <div className="flex gap-2">
          <Input
            id={nameId}
            value={name}
            maxLength={100}
            placeholder="e.g. PBS Support"
            onChange={(event) => setName(event.target.value)}
            className="max-w-sm"
          />
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create team'}
          </Button>
        </div>
      </div>
      <Message error={error} text={null} />
    </form>
  );
}

function ThisComputerCard({
  team,
  settings,
  onChange,
}: {
  team: OrganizationWithRole;
  settings: ThisDeviceSettings | null;
  onChange: (settings: ThisDeviceSettings) => void;
}) {
  const thisDevice = useAuthStore((state) => state.thisDevice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  const move = async (organizationId: string | null) => {
    const api = getDesktopApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    setText(null);
    const result = await api.thisDevice.updateSettings({ organizationId });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onChange(result.value);
    setText(organizationId ? 'This computer is now in the team.' : 'Removed from the team.');
    void devicesStore.getState().load();
  };

  const canAdd = team.role === 'owner' || team.role === 'admin';
  const inThisTeam = settings?.organizationId === team.id;
  const inOtherTeam = Boolean(settings?.organizationId) && !inThisTeam;

  return (
    <Card>
      <CardHeader>
        <CardTitle>This computer</CardTitle>
        <CardDescription>
          Team members can only connect to computers that are in the team.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!thisDevice ? (
          <p className="text-sm text-muted-foreground">
            Register this computer on the dashboard first.
          </p>
        ) : !settings ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{thisDevice.name}</span>
                <Badge variant={inThisTeam ? 'success' : 'outline'}>
                  {inThisTeam ? 'In this team' : inOtherTeam ? 'In another team' : 'Not in a team'}
                </Badge>
              </div>
              {inThisTeam ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void move(null)}>
                  Remove from team
                </Button>
              ) : (
                <Button size="sm" disabled={busy || !canAdd} onClick={() => void move(team.id)}>
                  {inOtherTeam ? 'Move to this team' : 'Add to team'}
                </Button>
              )}
            </div>
            {!inThisTeam && !canAdd ? (
              <p className="text-sm text-muted-foreground">
                Only an owner or admin can add their computer. Ask the team owner to make you an
                admin.
              </p>
            ) : null}
            <Message error={error} text={text} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddMemberForm({ team, onAdded }: { team: OrganizationWithRole; onAdded: () => void }) {
  const roles = assignableRoles(team.role);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('admin') ? 'admin' : 'operator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const emailId = useId();
  const roleId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const api = getDesktopApi();
    if (!api || !email.trim()) return;
    setBusy(true);
    setError(null);
    setText(null);
    const result = await api.teams.addMember(team.id, { email: email.trim(), role });
    setBusy(false);
    if (!result.ok) {
      setError(
        result.error.code === 'not_found'
          ? 'No account with that email. They need to sign up in the app first.'
          : result.error.message,
      );
      return;
    }
    setEmail('');
    setText('Member added.');
    onAdded();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2 border-t pt-4">
      <h3 className="text-sm font-medium">Add a member</h3>
      <p className="text-sm text-muted-foreground">
        The person must already have an account in the app.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-64"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={roleId}>Role</Label>
          <NativeSelect
            id={roleId}
            value={role}
            className="w-36"
            onChange={(event) => {
              const next = roles.find((r) => r === event.target.value);
              if (next) setRole(next);
            }}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Adding…' : 'Add member'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{ROLE_HELP[role]}</p>
      <Message error={error} text={text} />
    </form>
  );
}

function MembersCard({
  team,
  onLeft,
}: {
  team: OrganizationWithRole;
  /** Called after the signed-in user leaves the team. */
  onLeft: () => void;
}) {
  const me = useAuthStore((state) => state.user?.id ?? null);
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = getDesktopApi();
    if (!api) return;
    const result = await api.teams.members(team.id);
    if (result.ok) {
      setMembers(result.value);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, [team.id]);

  useEffect(() => {
    setMembers(null);
    void load();
  }, [load]);

  const run = async (work: () => Promise<IpcResult>, after?: () => void) => {
    setBusy(true);
    setError(null);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (after) after();
    else void load();
  };

  const api = getDesktopApi();
  if (!api) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          Your role: <span className="font-medium">{ROLE_LABELS[team.role]}</span>.{' '}
          {ROLE_HELP[team.role]}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {members === null && !error ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : null}
        {members ? (
          <ul className="divide-y rounded-md border" aria-label="Team members">
            {members.map((member) => {
              const self = member.userId === me;
              const editable = !self && canManage(team.role, member.role, null);
              return (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {member.displayName ?? 'Unnamed account'}
                      {self ? <span className="text-muted-foreground"> (you)</span> : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {editable ? (
                      <NativeSelect
                        aria-label={`Role of ${member.displayName ?? 'member'}`}
                        value={member.role}
                        disabled={busy}
                        className="w-32"
                        onChange={(event) => {
                          const role = assignableRoles(team.role).find(
                            (r) => r === event.target.value,
                          );
                          if (role) {
                            void run(() => api.teams.updateMember(team.id, member.userId, role));
                          }
                        }}
                      >
                        {assignableRoles(team.role).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Badge variant="outline">{ROLE_LABELS[member.role]}</Badge>
                    )}
                    {editable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.teams.removeMember(team.id, member.userId))
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                    {self ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.teams.removeMember(team.id, member.userId), onLeft)
                        }
                      >
                        Leave
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {assignableRoles(team.role).length > 0 ? (
          <AddMemberForm team={team} onAdded={() => void load()} />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function TeamPage() {
  const signedIn = useAuthStore((state) => state.status === 'signed-in');
  const thisDevice = useAuthStore((state) => state.thisDevice);
  const [teams, setTeams] = useState<OrganizationWithRole[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ThisDeviceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const selectId = useId();

  const load = useCallback(async () => {
    const api = getDesktopApi();
    if (!api) return;
    setLoading(true);
    setError(null);
    const [list, device] = await Promise.all([api.teams.list(), api.thisDevice.getSettings()]);
    setLoading(false);
    if (!list.ok) {
      setError(list.error.message);
      return;
    }
    setTeams(list.value);
    if (device.ok) setSettings(device.value);
    setSelectedId((current) =>
      current && list.value.some((team) => team.id === current)
        ? current
        : (list.value.find((team) => device.ok && team.id === device.value?.organizationId)?.id ??
          list.value[0]?.id ??
          null),
    );
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, thisDevice, load]);

  const selected = teams?.find((team) => team.id === selectedId) ?? null;
  const refresh = (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      <RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
      Refresh
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Team"
        description="Connect to computers signed in with other accounts. Both computers must be in the same team."
        actions={signedIn && getDesktopApi() ? refresh : undefined}
      />

      {!getDesktopApi() ? (
        <p className="text-sm text-muted-foreground">Available in the desktop app.</p>
      ) : !signedIn ? (
        <p className="text-sm text-muted-foreground">Sign in to manage your team.</p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : teams === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : teams.length === 0 || creating ? (
        <Card>
          <CardHeader>
            <CardTitle>{teams.length === 0 ? 'Create your team' : 'Create another team'}</CardTitle>
            <CardDescription>
              1. Create a team. 2. Add the other account by email. 3. On each computer, open this
              page and add the computer to the team.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <CreateTeamForm
              onCreated={(team) => {
                setCreating(false);
                setTeams((list) => [...(list ?? []), team]);
                setSelectedId(team.id);
              }}
            />
            {teams.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={selectId}>Team</Label>
              <NativeSelect
                id={selectId}
                value={selectedId ?? ''}
                className="w-64"
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              New team
            </Button>
          </div>
          {selected ? (
            <>
              <ThisComputerCard team={selected} settings={settings} onChange={setSettings} />
              <MembersCard
                key={selected.id}
                team={selected}
                onLeft={() => {
                  setSelectedId(null);
                  void load();
                }}
              />
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
