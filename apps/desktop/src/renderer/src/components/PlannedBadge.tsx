import { FEATURES, type FeatureKey } from '@remote-desktop/shared';
import { Badge, Tooltip } from '@remote-desktop/ui';
import { Clock } from 'lucide-react';

/** Marks UI for functionality that is not implemented yet (see FEATURES in @remote-desktop/shared). */
export function PlannedBadge({ feature }: { feature: FeatureKey }) {
  const info = FEATURES[feature];
  if (info.status === 'available') return null;
  return (
    <Tooltip content={`${info.label} is not available yet. Planned for phase ${info.phase}.`}>
      <Badge variant="outline" tabIndex={0}>
        <Clock aria-hidden="true" />
        Planned · Phase {info.phase}
      </Badge>
    </Tooltip>
  );
}

export function plannedDescription(feature: FeatureKey): string {
  const info = FEATURES[feature];
  return `${info.label} — not available yet (planned for phase ${info.phase})`;
}
