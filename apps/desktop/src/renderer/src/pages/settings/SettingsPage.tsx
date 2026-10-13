import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  NativeSelect,
  Switch,
  cn,
} from '@remote-desktop/ui';
import { QUALITY_PRESETS, type QualityPreset } from '@remote-desktop/webrtc';
import { NavLink, Navigate, Outlet, useParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { THEME_OPTIONS } from '@/components/ThemeMenu';
import { useSettingsStore, type ConnectDefaults } from '@/stores/settings-store';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';
import { THEME_SOURCES } from '../../../../shared/ipc';
import { ActivityHistory } from './ActivityHistory';
import { SecuritySettings } from './SecuritySettings';
import { PlannedSettingRow, SettingRow } from './SettingRow';
import { SETTINGS_SECTIONS, findSettingsSection } from './sections';

export function SettingsLayout() {
  return (
    <>
      <PageHeader title="Settings" description="Preferences for this device." />
      <div className="flex flex-col gap-6 md:flex-row">
        <nav aria-label="Settings sections" className="md:w-52 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <NavLink
                  to={`/settings/${id}`}
                  className={({ isActive }) =>
                    cn(
                      'flex h-9 items-center gap-2.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </>
  );
}

/** Settings that are implemented. */
function GeneralSettings() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const showSampleData = useSettingsStore((state) => state.showSampleData);
  const setShowSampleData = useSettingsStore((state) => state.setShowSampleData);

  return (
    <>
      <SettingRow
        label="Theme"
        description="Use a light or dark appearance, or follow Windows."
        control={({ controlId, descriptionId }) => (
          <NativeSelect
            id={controlId}
            aria-describedby={descriptionId}
            className="w-48"
            value={preference}
            onChange={(event) => {
              const value = THEME_SOURCES.find((source) => source === event.target.value);
              if (value) setPreference(value satisfies ThemePreference);
            }}
          >
            {THEME_SOURCES.map((source) => (
              <option key={source} value={source}>
                {THEME_OPTIONS[source].label}
              </option>
            ))}
          </NativeSelect>
        )}
      />
      <SettingRow
        label="Show sample data"
        description="No backend is connected in this build. Turn this on to preview the app with example devices and sessions."
        control={({ controlId, descriptionId }) => (
          <Switch
            id={controlId}
            aria-describedby={descriptionId}
            checked={showSampleData}
            onCheckedChange={setShowSampleData}
          />
        )}
      />
    </>
  );
}

const CONNECT_DEFAULTS: { key: keyof ConnectDefaults; label: string; description: string }[] = [
  {
    key: 'control',
    label: 'Ask for mouse and keyboard control',
    description: 'Pre-selected when you connect to another device. The remote side still decides.',
  },
  {
    key: 'clipboard',
    label: 'Ask for clipboard transfer',
    description: 'Pre-selected when you connect to another device. The remote side still decides.',
  },
  {
    key: 'fileTransfer',
    label: 'Ask for file transfer',
    description: 'Pre-selected when you connect to another device. The remote side still decides.',
  },
];

/** What the connect form asks for by default (outgoing sessions). */
function ConnectDefaultsSettings() {
  const defaults = useSettingsStore((state) => state.connectDefaults);
  const setConnectDefault = useSettingsStore((state) => state.setConnectDefault);
  return (
    <>
      {CONNECT_DEFAULTS.map(({ key, label, description }) => (
        <SettingRow
          key={key}
          label={label}
          description={description}
          control={({ controlId, descriptionId }) => (
            <Switch
              id={controlId}
              aria-describedby={descriptionId}
              checked={defaults[key]}
              onCheckedChange={(checked) => setConnectDefault(key, checked)}
            />
          )}
        />
      ))}
    </>
  );
}

const QUALITY_LABELS: Record<QualityPreset, string> = {
  auto: 'Auto (adaptive)',
  quality: 'Best quality',
  balanced: 'Balanced',
  speed: 'Fastest',
};

function QualitySettings() {
  const defaultQuality = useSettingsStore((state) => state.defaultQuality);
  const setDefaultQuality = useSettingsStore((state) => state.setDefaultQuality);
  return (
    <SettingRow
      label="Visual quality"
      description="Quality new sessions start with. You can still change it during a session."
      control={({ controlId, descriptionId }) => (
        <NativeSelect
          id={controlId}
          aria-describedby={descriptionId}
          className="w-48"
          value={defaultQuality}
          onChange={(event) => {
            const value = QUALITY_PRESETS.find((preset) => preset === event.target.value);
            if (value) setDefaultQuality(value);
          }}
        >
          {QUALITY_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {QUALITY_LABELS[preset]}
            </option>
          ))}
        </NativeSelect>
      )}
    />
  );
}

/** Working settings shown above a section's planned ones. */
function ImplementedSettings({ sectionId }: { sectionId: string }) {
  switch (sectionId) {
    case 'general':
      return <GeneralSettings />;
    case 'security':
      return <SecuritySettings />;
    case 'remote-access':
      return <ConnectDefaultsSettings />;
    case 'privacy':
      return <ActivityHistory />;
    case 'performance':
      return <QualitySettings />;
    default:
      return null;
  }
}

export function SettingsSectionPage() {
  const { section: sectionId } = useParams();
  const section = findSettingsSection(sectionId);
  if (!section) return <Navigate to="/settings/general" replace />;

  return (
    <Card>
      <CardHeader className="border-b pb-4">
        <CardTitle>{section.label}</CardTitle>
        <CardDescription>{section.description}</CardDescription>
      </CardHeader>
      <div className="divide-y">
        <ImplementedSettings sectionId={section.id} />
        {section.planned.map((setting) => (
          <PlannedSettingRow key={setting.id} setting={setting} />
        ))}
      </div>
    </Card>
  );
}
