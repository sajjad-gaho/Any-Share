import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@remote-desktop/ui';
import { Laptop, Moon, Sun } from 'lucide-react';
import { THEME_SOURCES } from '../../../shared/ipc';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';

export const THEME_OPTIONS: Record<ThemePreference, { label: string; icon: typeof Sun }> = {
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
  system: { label: 'System', icon: Laptop },
};

function isThemePreference(value: string): value is ThemePreference {
  return (THEME_SOURCES as readonly string[]).includes(value);
}

export function ThemeMenu({ compact = false }: { compact?: boolean }) {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const Current = THEME_OPTIONS[preference].icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? 'icon' : 'default'}
          className={compact ? undefined : 'w-full justify-start'}
          aria-label={`Theme: ${THEME_OPTIONS[preference].label}`}
        >
          <Current aria-hidden="true" />
          {compact ? null : <span>Theme: {THEME_OPTIONS[preference].label}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) setPreference(value);
          }}
        >
          {THEME_SOURCES.map((source) => {
            const { label, icon: Icon } = THEME_OPTIONS[source];
            return (
              <DropdownMenuRadioItem key={source} value={source}>
                <Icon aria-hidden="true" />
                {label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
