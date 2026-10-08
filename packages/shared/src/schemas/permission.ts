import { z } from 'zod';

/**
 * Organisation roles, highest first. Stored in `organization_members.role`.
 * The server always reads the role from the database; a role sent by a client
 * is never trusted.
 */
export const ROLES = ['owner', 'admin', 'operator', 'user'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * Organisation-level capabilities granted by role (see `@remote-desktop/security`).
 */
export const ORG_CAPABILITIES = [
  'organization.delete',
  'organization.manage_settings',
  'organization.manage_members',
  'device.view_all',
  'device.manage',
  'device.connect',
  'audit.view',
] as const;
export const orgCapabilitySchema = z.enum(ORG_CAPABILITIES);
export type OrgCapability = z.infer<typeof orgCapabilitySchema>;

/**
 * Session-scoped permissions: what a controller may do inside one session.
 * Stored in `device_permissions.permissions` (the ceiling for a user on a
 * device) and `session_permissions` (what was actually granted for a session).
 *
 * `remote_control` is the umbrella for input: `mouse` and `keyboard` are only
 * meaningful together with it.
 */
export const SESSION_PERMISSIONS = [
  'screen_view',
  'mouse',
  'keyboard',
  'clipboard',
  'file_transfer',
  'audio',
  'remote_control',
] as const;
export const sessionPermissionSchema = z.enum(SESSION_PERMISSIONS);
export type SessionPermission = z.infer<typeof sessionPermissionSchema>;

export const PERMISSION_LABELS: Readonly<Record<SessionPermission, string>> = {
  screen_view: 'Screen view',
  mouse: 'Mouse',
  keyboard: 'Keyboard',
  clipboard: 'Clipboard',
  file_transfer: 'File transfer',
  audio: 'Audio',
  remote_control: 'Remote control',
};

const INPUT_PERMISSIONS: readonly SessionPermission[] = ['mouse', 'keyboard'];

/** Validation rules shared by every permission set; returns an error message or null. */
export function permissionSetProblem(list: readonly SessionPermission[]): string | null {
  if (list.length === 0) return 'At least one permission is required';
  if (new Set(list).size !== list.length) return 'Permissions must not repeat';
  if (!list.includes('screen_view')) return 'Every session requires the screen view permission';
  if (list.some((p) => INPUT_PERMISSIONS.includes(p)) && !list.includes('remote_control')) {
    return 'Mouse and keyboard require the remote control permission';
  }
  return null;
}

/** A de-duplicated, non-empty, internally consistent set of session permissions. */
export const sessionPermissionSetSchema = z
  .array(sessionPermissionSchema)
  .max(SESSION_PERMISSIONS.length)
  .superRefine((list, ctx) => {
    const problem = permissionSetProblem(list);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/** Canonical ordering so sets compare and store deterministically. */
export function sortPermissions(list: Iterable<SessionPermission>): SessionPermission[] {
  const set = new Set(list);
  return SESSION_PERMISSIONS.filter((p) => set.has(p));
}

/** Intersection of two permission sets, in canonical order. */
export function intersectPermissions(
  a: readonly SessionPermission[],
  b: readonly SessionPermission[],
): SessionPermission[] {
  return sortPermissions(a.filter((p) => b.includes(p)));
}

/**
 * Drops input permissions that lost their `remote_control` umbrella, so an
 * intersection never yields an inconsistent set.
 */
export function normalizePermissions(list: readonly SessionPermission[]): SessionPermission[] {
  const sorted = sortPermissions(list);
  return sorted.includes('remote_control')
    ? sorted
    : sorted.filter((p) => !INPUT_PERMISSIONS.includes(p));
}
