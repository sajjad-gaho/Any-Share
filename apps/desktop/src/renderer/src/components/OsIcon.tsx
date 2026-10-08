import type { OsFamily } from '@remote-desktop/shared';
import { cn } from '@remote-desktop/ui';
import { Laptop, Monitor, Server, Smartphone, type LucideIcon } from 'lucide-react';

const OS_ICONS: Record<OsFamily, LucideIcon> = {
  windows: Monitor,
  macos: Laptop,
  linux: Server,
  android: Smartphone,
  ios: Smartphone,
};

export function OsIcon({ family, className }: { family: OsFamily; className?: string }) {
  const Icon = OS_ICONS[family];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary',
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}
