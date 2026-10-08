import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  NativeSelect,
  Switch,
  cn,
} from '@remote-desktop/ui';
import { NavLink, Navigate, Outlet, useParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { THEME_OPTIONS } from '@/components/ThemeMenu';
import { useSettingsStore } from '@/stores/settings-store';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';
import { THEME_SOURCES } from '../../../../shared/ipc';
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

/** Settings that are implemented in Phase 1. */
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
        {section.id === 'general' ? <GeneralSettings /> : null}
        {section.planned.map((setting) => (
          <PlannedSettingRow key={setting.id} setting={setting} />
        ))}
      </div>
    </Card>
  );
}
