/**
 * Registry of product capabilities and their implementation status.
 *
 * Every piece of UI that represents functionality which does not exist yet must
 * reference an entry here with status `planned`, so unfinished work is explicit
 * in code and visible to users. Flip an entry to `available` only when the
 * feature genuinely works end to end.
 */
export type FeatureStatus = 'available' | 'planned';

export interface FeatureInfo {
  readonly label: string;
  readonly status: FeatureStatus;
  /** Delivery phase the feature is scheduled for. */
  readonly phase: number;
}

export const FEATURES = {
  // Phase 1: foundation (implemented)
  themeSelection: { label: 'Theme selection', status: 'available', phase: 1 },
  addressBook: { label: 'Local address book', status: 'available', phase: 1 },
  localProfile: { label: 'Local display name', status: 'available', phase: 1 },
  sampleData: { label: 'Sample data preview', status: 'available', phase: 1 },

  // Phase 2: accounts and backend (implemented)
  authentication: { label: 'Accounts and sign-in', status: 'available', phase: 2 },
  deviceRegistration: { label: 'Device registration', status: 'available', phase: 2 },

  // Phase 3: remote sessions (implemented)
  remoteSession: { label: 'Remote session transport (WebRTC)', status: 'available', phase: 3 },
  screenCapture: { label: 'Screen capture', status: 'available', phase: 3 },
  remoteInput: { label: 'Remote mouse and keyboard', status: 'available', phase: 3 },
  multiMonitor: { label: 'Multi-monitor', status: 'available', phase: 3 },
  sessionQuality: { label: 'Quality and performance controls', status: 'available', phase: 3 },
  natTraversal: { label: 'STUN/TURN relay configuration', status: 'available', phase: 3 },
  nativeHelper: { label: 'Windows native helper', status: 'available', phase: 3 },
  clipboardSync: { label: 'Clipboard transfer', status: 'available', phase: 3 },
  fileTransfer: { label: 'File transfer', status: 'available', phase: 3 },

  // Later phases (not implemented)
  /** Saved per-device defaults (approval, quality, relay...). Sessions work without them. */
  sessionPreferences: { label: 'Saved session preferences', status: 'planned', phase: 4 },
  audio: { label: 'Audio streaming', status: 'planned', phase: 4 },
  unattendedAccess: { label: 'Unattended access', status: 'planned', phase: 4 },
  accessControl: { label: 'Access control (RBAC)', status: 'planned', phase: 4 },
  auditLogs: { label: 'Audit logs', status: 'planned', phase: 4 },
  notifications: { label: 'Desktop notifications', status: 'planned', phase: 4 },
  launchAtStartup: { label: 'Launch at startup', status: 'planned', phase: 4 },
  localization: { label: 'Language selection', status: 'planned', phase: 4 },
} as const satisfies Record<string, FeatureInfo>;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureAvailable(key: FeatureKey): boolean {
  return FEATURES[key].status === 'available';
}
