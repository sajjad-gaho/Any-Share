import type { FeatureKey } from '@remote-desktop/shared';
import {
  Bell,
  Eye,
  Gauge,
  MonitorSmartphone,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings for functionality that does not exist yet.
 *
 * These are rendered as DISABLED controls with a "Planned" badge. They hold no
 * state and change nothing. When the backing feature is implemented, move the
 * setting into a real store and flip the feature in FEATURES to "available".
 */
export type PlannedControl =
  | { kind: 'switch'; defaultValue: boolean }
  | { kind: 'select'; options: readonly string[]; defaultValue: string }
  | { kind: 'text'; placeholder: string };

export interface PlannedSetting {
  id: string;
  label: string;
  description: string;
  feature: FeatureKey;
  control: PlannedControl;
}

export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  planned: readonly PlannedSetting[];
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Appearance and basic behaviour of the app.',
    icon: SlidersHorizontal,
    planned: [
      {
        id: 'language',
        label: 'Language',
        description: 'Display language for the interface.',
        feature: 'localization',
        control: { kind: 'select', options: ['English'], defaultValue: 'English' },
      },
      {
        id: 'launch-at-startup',
        label: 'Launch at startup',
        description: 'Start the app in the background when you sign in to Windows.',
        feature: 'launchAtStartup',
        control: { kind: 'switch', defaultValue: false },
      },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Protect this device and your account.',
    icon: ShieldCheck,
    planned: [
      {
        id: 'two-factor',
        label: 'Two-factor authentication',
        description: 'Require a second factor when signing in to your account.',
        feature: 'authentication',
        control: { kind: 'switch', defaultValue: false },
      },
      {
        id: 'unattended-password',
        label: 'Unattended access password',
        description: 'Allow connections without someone accepting them, protected by a password.',
        feature: 'unattendedAccess',
        control: { kind: 'switch', defaultValue: false },
      },
      {
        id: 'require-approval',
        label: 'Always ask before accepting a session',
        description: 'Someone at this device must approve every incoming connection.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: true },
      },
      {
        id: 'lock-on-end',
        label: 'Lock this device when a session ends',
        description: 'Locks Windows automatically after a remote session finishes.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: false },
      },
    ],
  },
  {
    id: 'remote-access',
    label: 'Remote Access',
    description: 'What people connecting to this device are allowed to do.',
    icon: MonitorSmartphone,
    planned: [
      {
        id: 'allow-incoming',
        label: 'Allow incoming connections',
        description: 'Let other devices request a session with this one.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: true },
      },
      {
        id: 'allow-input',
        label: 'Allow mouse and keyboard control',
        description: 'Remote users can control input once you accept.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: true },
      },
      {
        id: 'allow-clipboard',
        label: 'Allow clipboard sync',
        description: 'Share copied text between the two devices.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: false },
      },
      {
        id: 'allow-files',
        label: 'Allow file transfer',
        description: 'Remote users can send and receive files.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: false },
      },
      {
        id: 'allow-audio',
        label: 'Transmit audio',
        description: 'Play this device’s sound on the remote side.',
        feature: 'audio',
        control: { kind: 'switch', defaultValue: false },
      },
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Control what is visible and recorded.',
    icon: Eye,
    planned: [
      {
        id: 'blank-screen',
        label: 'Blank this screen during unattended sessions',
        description: 'Hides the local display while someone works remotely.',
        feature: 'unattendedAccess',
        control: { kind: 'switch', defaultValue: false },
      },
      {
        id: 'session-history',
        label: 'Keep session history',
        description: 'Record who connected, when, and for how long.',
        feature: 'auditLogs',
        control: { kind: 'switch', defaultValue: true },
      },
    ],
  },
  {
    id: 'network',
    label: 'Network',
    description: 'How connections are established.',
    icon: Network,
    planned: [
      {
        id: 'connection-mode',
        label: 'Connection mode',
        description: 'Prefer direct peer-to-peer connections, or always use a relay.',
        feature: 'sessionPreferences',
        control: {
          kind: 'select',
          options: ['Automatic', 'Direct only', 'Relay only'],
          defaultValue: 'Automatic',
        },
      },
      {
        id: 'turn-server',
        label: 'Custom relay (TURN) server',
        description: 'Route relayed traffic through your own infrastructure.',
        feature: 'sessionPreferences',
        control: { kind: 'text', placeholder: 'turns:relay.example.com:443' },
      },
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Balance image quality against responsiveness.',
    icon: Gauge,
    planned: [
      {
        id: 'quality',
        label: 'Visual quality',
        description: 'Default quality preset for new sessions.',
        feature: 'sessionPreferences',
        control: {
          kind: 'select',
          options: ['Balanced', 'Best quality', 'Best responsiveness'],
          defaultValue: 'Balanced',
        },
      },
      {
        id: 'frame-rate',
        label: 'Frame rate limit',
        description: 'Upper bound for the remote screen frame rate.',
        feature: 'sessionPreferences',
        control: { kind: 'select', options: ['30 fps', '60 fps'], defaultValue: '30 fps' },
      },
      {
        id: 'hardware-encoding',
        label: 'Hardware video encoding',
        description: 'Use the GPU to encode the screen when available.',
        feature: 'sessionPreferences',
        control: { kind: 'switch', defaultValue: true },
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Choose what the app tells you about.',
    icon: Bell,
    planned: [
      {
        id: 'notify-requests',
        label: 'Incoming connection requests',
        description: 'Show a notification when someone asks to connect.',
        feature: 'notifications',
        control: { kind: 'switch', defaultValue: true },
      },
      {
        id: 'notify-session-end',
        label: 'Session ended',
        description: 'Notify when a remote session finishes.',
        feature: 'notifications',
        control: { kind: 'switch', defaultValue: false },
      },
      {
        id: 'notify-sounds',
        label: 'Play sounds',
        description: 'Play a sound with notifications.',
        feature: 'notifications',
        control: { kind: 'switch', defaultValue: true },
      },
    ],
  },
];

export function findSettingsSection(id: string | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}
