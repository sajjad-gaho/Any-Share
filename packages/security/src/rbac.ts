import {
  ORG_CAPABILITIES,
  ROLES,
  SESSION_PERMISSIONS,
  type OrgCapability,
  type Role,
  type SessionPermission,
} from '@remote-desktop/shared';

/**
 * Role -> organisation capability mapping.
 *
 * This is policy only. The server evaluates it with the role it reads from
 * `organization_members` (never one supplied by a client); RLS in Postgres
 * enforces the same rules for direct database access. Clients may use it to
 * hide UI the user cannot use.
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly OrgCapability[]>> = {
  owner: ORG_CAPABILITIES,
  admin: ORG_CAPABILITIES.filter((capability) => capability !== 'organization.delete'),
  operator: ['device.view_all', 'device.connect'],
  user: [],
};

/**
 * The most a member may do in a session on an organisation device when no
 * explicit `device_permissions` row exists for them. An explicit row replaces
 * this ceiling (it can grant `user`s access, or restrict an operator).
 */
export const ROLE_SESSION_CEILING: Readonly<Record<Role, readonly SessionPermission[]>> = {
  owner: SESSION_PERMISSIONS,
  admin: SESSION_PERMISSIONS,
  operator: ['screen_view', 'mouse', 'keyboard', 'clipboard', 'remote_control'],
  user: [],
};

export function capabilitiesForRole(role: Role): readonly OrgCapability[] {
  return ROLE_CAPABILITIES[role];
}

export function hasCapability(role: Role, capability: OrgCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function hasAllCapabilities(role: Role, capabilities: readonly OrgCapability[]): boolean {
  return capabilities.every((capability) => hasCapability(role, capability));
}

/** 0 = owner (highest). */
export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function isRoleAtLeast(role: Role, minimum: Role): boolean {
  return roleRank(role) <= roleRank(minimum);
}

/**
 * Whether `actor` may assign `targetRole` to someone, or change/remove a member
 * who currently holds `currentRole`. Owners manage everyone; admins manage only
 * operators and users; nobody else manages members.
 */
export function canManageMember(
  actor: Role,
  currentRole: Role | null,
  targetRole: Role | null,
): boolean {
  if (!hasCapability(actor, 'organization.manage_members')) return false;
  if (actor === 'owner') return true;
  const manageable: readonly Role[] = ['operator', 'user'];
  return (
    (currentRole === null || manageable.includes(currentRole)) &&
    (targetRole === null || manageable.includes(targetRole))
  );
}
