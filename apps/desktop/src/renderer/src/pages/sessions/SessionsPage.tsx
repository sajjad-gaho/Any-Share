import { SESSION_STATUSES, type SessionStatus } from '@remote-desktop/shared';
import { Button, EmptyState, Label, NativeSelect } from '@remote-desktop/ui';
import { History, RefreshCw, SearchX } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { CollectionState } from '@/components/CollectionState';
import { PageHeader } from '@/components/PageHeader';
import { SampleDataNotice } from '@/components/SampleDataNotice';
import { SessionsTable } from '@/components/SessionsTable';
import { sessionsStore } from '@/stores/app-stores';
import { useCollection, useEnsureLoaded } from '@/stores/collection-store';

const STATUS_LABELS: Record<SessionStatus, string> = {
  connecting: 'Connecting',
  active: 'Active',
  ended: 'Ended',
  failed: 'Failed',
  rejected: 'Rejected',
};

export function SessionsPage() {
  useEnsureLoaded(sessionsStore);
  const sessions = useCollection(sessionsStore, (state) => state.items);
  const status = useCollection(sessionsStore, (state) => state.status);
  const error = useCollection(sessionsStore, (state) => state.error);
  const [statusFilter, setStatusFilter] = useState<'all' | SessionStatus>('all');
  const filterId = useId();

  const visible = useMemo(
    () =>
      statusFilter === 'all'
        ? sessions
        : sessions.filter((session) => session.status === statusFilter),
    [sessions, statusFilter],
  );
  const reload = () => void sessionsStore.getState().load();

  return (
    <>
      <PageHeader
        title="Sessions"
        description="History of remote sessions started from this device."
        actions={
          <Button variant="outline" size="sm" onClick={reload} disabled={status === 'loading'}>
            <RefreshCw
              aria-hidden="true"
              className={status === 'loading' ? 'animate-spin' : undefined}
            />
            Refresh
          </Button>
        }
      />

      <SampleDataNotice />

      <div className="w-44 space-y-1.5">
        <Label htmlFor={filterId}>Status</Label>
        <NativeSelect
          id={filterId}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as 'all' | SessionStatus)}
        >
          <option value="all">All statuses</option>
          {SESSION_STATUSES.map((option) => (
            <option key={option} value={option}>
              {STATUS_LABELS[option]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <CollectionState
        status={status}
        error={error}
        itemCount={sessions.length}
        onRetry={reload}
        empty={
          <EmptyState
            icon={<History />}
            title="No sessions yet"
            description="Sessions appear here after you connect to a device."
          />
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No sessions with this status"
            action={
              <Button variant="outline" size="sm" onClick={() => setStatusFilter('all')}>
                Show all sessions
              </Button>
            }
          />
        ) : (
          <SessionsTable sessions={visible} caption="Remote session history" />
        )}
      </CollectionState>
    </>
  );
}
