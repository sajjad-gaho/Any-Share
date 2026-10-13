import type { AuditAction, AuditLog } from '@remote-desktop/shared';
import { Button } from '@remote-desktop/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getDesktopApi } from '@/lib/desktop-api';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth-store';

const ACTION_LABELS: Record<AuditAction, string> = {
  LOGIN: 'Signed in',
  LOGOUT: 'Signed out',
  DEVICE_REGISTERED: 'Device registered',
  DEVICE_REVOKED: 'Device removed',
  CONNECTION_REQUESTED: 'Connection requested',
  CONNECTION_APPROVED: 'Connection approved',
  CONNECTION_REJECTED: 'Connection declined',
  SESSION_STARTED: 'Session started',
  SESSION_ENDED: 'Session ended',
  PERMISSION_CHANGED: 'Permissions changed',
  FILE_TRANSFER_STARTED: 'File transfer started',
  FILE_TRANSFER_COMPLETED: 'File transfer completed',
  FILE_TRANSFER_CANCELLED: 'File transfer cancelled',
  CLIPBOARD_TRANSFERRED: 'Clipboard transferred',
};

/** Metadata worth showing; everything else (user agents, key fingerprints…) stays out. */
const DETAIL_KEYS: Record<string, string> = {
  permissions: 'Permissions',
  reason: 'Reason',
  outcome: 'Outcome',
  automatic: 'Automatic',
  deviceCode: 'Device',
};

function details(entry: AuditLog): string {
  return Object.entries(DETAIL_KEYS)
    .flatMap(([key, label]) => {
      const value = entry.metadata[key];
      if (value === undefined || value === null || value === '') return [];
      const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
      return [`${label}: ${text.replaceAll(',', ', ')}`];
    })
    .join(' · ');
}

/**
 * Activity recorded by the server (audit log). Recording cannot be turned off
 * here: it is part of the security model. The server decides what this
 * account may see (its own actions, or its organisation's for admins).
 */
export function ActivityHistory() {
  const signedIn = useAuthStore((state) => state.status === 'signed-in');
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [entries, setEntries] = useState<AuditLog[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (before?: string) => {
    const api = getDesktopApi();
    if (!api) return;
    setStatus('loading');
    setError(null);
    const result = await api.audit.list(before ? { before } : undefined);
    if (!result.ok) {
      setError(result.error.message);
      setStatus('error');
      return;
    }
    setEntries((list) => (before ? [...list, ...result.value] : result.value));
    setHasMore(result.value.length >= 50);
    setStatus('done');
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  if (!getDesktopApi()) {
    return <p className="px-5 py-4 text-sm text-muted-foreground">Available in the desktop app.</p>;
  }
  if (!signedIn) {
    return <p className="px-5 py-4 text-sm text-muted-foreground">Sign in to see your activity.</p>;
  }

  return (
    <section aria-labelledby="activity-heading" className="space-y-3 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 id="activity-heading" className="text-sm font-medium">
            Session history
          </h3>
          <p className="text-sm text-muted-foreground">
            Sign-ins, connections, sessions and transfers recorded for your account. History is
            always kept for security and cannot be turned off.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
          disabled={status === 'loading'}
        >
          <RefreshCw
            aria-hidden="true"
            className={status === 'loading' ? 'animate-spin' : undefined}
          />
          Refresh
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {status === 'done' && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : null}

      {entries.length > 0 ? (
        <ul className="divide-y rounded-md border" aria-label="Activity">
          {entries.map((entry) => {
            const extra = details(entry);
            return (
              <li key={entry.id} className="flex items-start justify-between gap-4 px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">{ACTION_LABELS[entry.action]}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.actorUserId === null
                      ? 'System'
                      : entry.actorUserId === userId
                        ? 'You'
                        : 'Another user'}
                    {extra ? ` · ${extra}` : ''}
                  </p>
                </div>
                <time
                  dateTime={entry.createdAt}
                  className="shrink-0 text-xs text-muted-foreground tabular-nums"
                >
                  {formatDateTime(entry.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      ) : null}

      {hasMore ? (
        <Button
          size="sm"
          variant="outline"
          disabled={status === 'loading'}
          onClick={() => void load(entries.at(-1)?.createdAt)}
        >
          Show older
        </Button>
      ) : null}
    </section>
  );
}
