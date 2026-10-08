import type { DeviceId, DeviceStatus } from '@remote-desktop/shared';
import { Button, type ButtonProps } from '@remote-desktop/ui';
import { Plug } from 'lucide-react';
import { Link } from 'react-router';

interface ConnectButtonProps {
  deviceId: DeviceId;
  deviceName: string;
  /** When known to be offline the button is disabled. Unknown status (address book) stays enabled. */
  status?: DeviceStatus;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
}

export function ConnectButton({
  deviceId,
  deviceName,
  status,
  size = 'sm',
  variant = 'default',
}: ConnectButtonProps) {
  const label = `Connect to ${deviceName}`;
  if (status === 'offline') {
    return (
      <Button size={size} variant="outline" disabled aria-label={`${deviceName} is offline`}>
        <Plug aria-hidden="true" />
        Connect
      </Button>
    );
  }
  return (
    <Button size={size} variant={variant} asChild>
      <Link to={`/session/${deviceId}`} aria-label={label}>
        <Plug aria-hidden="true" />
        Connect
      </Link>
    </Button>
  );
}
