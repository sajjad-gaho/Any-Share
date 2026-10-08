import { formatDeviceId, formatRelativeTime, type Device } from '@remote-desktop/shared';
import { Card } from '@remote-desktop/ui';
import { OS_LABELS } from '@/lib/format';
import { ConnectButton } from './ConnectButton';
import { OsIcon } from './OsIcon';
import { DeviceStatusBadge } from './StatusBadges';

export function DeviceCard({ device }: { device: Device }) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 p-4">
        <OsIcon family={device.os.family} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={device.name}>
            {device.name}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{formatDeviceId(device.id)}</p>
        </div>
        <DeviceStatusBadge status={device.status} />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t px-4 py-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {OS_LABELS[device.os.family]} ·{' '}
          {device.status === 'online'
            ? 'Available now'
            : `Seen ${formatRelativeTime(device.lastSeenAt)}`}
        </p>
        <ConnectButton deviceId={device.id} deviceName={device.name} status={device.status} />
      </div>
    </Card>
  );
}
