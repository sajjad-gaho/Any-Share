import type { DeviceStatus, SessionStatus } from '@remote-desktop/shared';
import { Badge, type BadgeProps } from '@remote-desktop/ui';
import type { ConnectionStatus } from '@remote-desktop/webrtc';

function Dot() {
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />;
}

export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <Badge variant={status === 'online' ? 'success' : 'secondary'}>
      <Dot />
      {status === 'online' ? 'Online' : 'Offline'}
    </Badge>
  );
}

const SESSION_STATUS: Record<SessionStatus, { label: string; variant: BadgeProps['variant'] }> = {
  connecting: { label: 'Connecting', variant: 'warning' },
  active: { label: 'Active', variant: 'success' },
  ended: { label: 'Ended', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
  rejected: { label: 'Rejected', variant: 'warning' },
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const { label, variant } = SESSION_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

const CONNECTION_STATUS: Record<
  ConnectionStatus,
  { label: string; variant: BadgeProps['variant'] }
> = {
  'not-connected': { label: 'Not connected', variant: 'secondary' },
  connecting: { label: 'Connecting', variant: 'warning' },
  connected: { label: 'Connected', variant: 'success' },
  reconnecting: { label: 'Reconnecting', variant: 'warning' },
  disconnected: { label: 'Disconnected', variant: 'secondary' },
  failed: { label: 'Connection failed', variant: 'destructive' },
};

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const { label, variant } = CONNECTION_STATUS[status];
  return (
    <Badge variant={variant} role="status">
      <Dot />
      {label}
    </Badge>
  );
}
