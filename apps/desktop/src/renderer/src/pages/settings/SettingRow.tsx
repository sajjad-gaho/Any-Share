import { Input, NativeSelect, Switch } from '@remote-desktop/ui';
import { useId, type ReactNode } from 'react';
import { PlannedBadge } from '@/components/PlannedBadge';
import type { PlannedSetting } from './sections';

interface SettingRowProps {
  label: string;
  description: string;
  /** Receives the ids to wire the control to the label/description. */
  control: (ids: { controlId: string; descriptionId: string }) => ReactNode;
  badge?: ReactNode;
}

export function SettingRow({ label, description, control, badge }: SettingRowProps) {
  const controlId = useId();
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={controlId} className="text-sm font-medium">
            {label}
          </label>
          {badge}
        </div>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="shrink-0">{control({ controlId, descriptionId })}</div>
    </div>
  );
}

/** A disabled, stateless control for a feature that is not implemented yet. */
export function PlannedSettingRow({ setting }: { setting: PlannedSetting }) {
  return (
    <SettingRow
      label={setting.label}
      description={setting.description}
      badge={<PlannedBadge feature={setting.feature} />}
      control={({ controlId, descriptionId }) => {
        const shared = { id: controlId, disabled: true, 'aria-describedby': descriptionId };
        switch (setting.control.kind) {
          case 'switch':
            return <Switch {...shared} checked={setting.control.defaultValue} />;
          case 'select':
            return (
              <NativeSelect
                {...shared}
                value={setting.control.defaultValue}
                className="w-48"
                onChange={() => undefined}
              >
                {setting.control.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </NativeSelect>
            );
          case 'text':
            return <Input {...shared} placeholder={setting.control.placeholder} className="w-64" />;
        }
      }}
    />
  );
}
