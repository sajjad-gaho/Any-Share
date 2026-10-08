import { FEATURES, isFeatureAvailable, type FeatureKey } from '@remote-desktop/shared';
import { Button, Tooltip, cn } from '@remote-desktop/ui';
import type { LucideIcon } from 'lucide-react';

interface ViewerToolbarButtonProps {
  icon: LucideIcon;
  label: string;
  feature: FeatureKey;
  onClick?: () => void;
  /** Icon-only (top toolbar). */
  compact?: boolean;
}

/**
 * Toolbar control bound to a feature. While the feature is planned the button
 * is aria-disabled (still focusable so keyboard users can read the tooltip
 * explaining why) and does nothing.
 */
export function ViewerToolbarButton({
  icon: Icon,
  label,
  feature,
  onClick,
  compact = false,
}: ViewerToolbarButtonProps) {
  const available = isFeatureAvailable(feature);
  const info = FEATURES[feature];
  const tooltip = available
    ? label
    : `${label}: not available yet (planned for phase ${info.phase})`;

  return (
    <Tooltip content={tooltip}>
      <Button
        variant="ghost"
        size={compact ? 'icon-sm' : 'sm'}
        aria-label={compact ? label : undefined}
        aria-disabled={!available}
        onClick={available ? onClick : undefined}
        className={cn(
          !compact && 'h-auto flex-col gap-1 px-3 py-1.5 text-[11px]',
          'aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed',
        )}
      >
        <Icon aria-hidden="true" />
        {compact ? null : label}
      </Button>
    </Tooltip>
  );
}
