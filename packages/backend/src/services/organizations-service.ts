import { canManageMember, hasCapability } from '@remote-desktop/security';
import type {
  OrgCapability,
  OrganizationMember,
  OrganizationWithRole,
  Role,
} from '@remote-desktop/shared';
import { userIdByEmail } from '../db/auth-lookups';
import { asUser, type Queryable } from '../db/types';
import { PG, conflict, forbidden, notFound, pgErrorCode } from '../errors';
import { toIso, type ServiceDeps } from './context';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: OrganizationWithRole['plan'];
  created_at: Date | string;
  role: Role;
}

interface MemberRow {
  organization_id: string;
  user_id: string;
  display_name: string | null;
  role: Role;
  created_at: Date | string;
}

const toOrg = (row: OrgRow): OrganizationWithRole => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  plan: row.plan,
  role: row.role,
  createdAt: toIso(row.created_at),
});

const toMember = (row: MemberRow): OrganizationMember => ({
  organizationId: row.organization_id,
  userId: row.user_id,
  displayName: row.display_name,
  role: row.role,
  createdAt: toIso(row.created_at),
});

export class OrganizationsService {
  constructor(private readonly deps: ServiceDeps) {}

  /** The caller's role, read from the database. Null when not a member. */
  async getRole(userId: string, organizationId: string, tx?: Queryable): Promise<Role | null> {
    const [row] = await (tx ?? this.deps.db).query<{ role: Role }>(
      `select role::text as role from public.organization_members
        where organization_id = $1 and user_id = $2`,
      [organizationId, userId],
    );
    return row?.role ?? null;
  }

  /**
   * Resolves the caller's role and checks a capability. Non-members get 404 so
   * organisation ids cannot be probed.
   */
  async requireCapability(
    userId: string,
    organizationId: string,
    capability: OrgCapability,
    tx?: Queryable,
  ): Promise<Role> {
    const role = await this.getRole(userId, organizationId, tx);
    if (!role) throw notFound('Organization');
    if (!hasCapability(role, capability)) throw forbidden();
    return role;
  }

  async create(
    userId: string,
    input: { name: string; slug: string },
  ): Promise<OrganizationWithRole> {
    try {
      return await this.deps.db.transaction(async (tx) => {
        const [org] = await tx.query<Omit<OrgRow, 'role'>>(
          `insert into public.organizations (name, slug, created_by) values ($1, $2, $3)
           returning id, name, slug, plan, created_at`,
          [input.name, input.slug, userId],
        );
        if (!org) throw new Error('Insert returned no row');
        await tx.query(
          `insert into public.organization_members (organization_id, user_id, role)
           values ($1, $2, 'owner')`,
          [org.id, userId],
        );
        return toOrg({ ...org, role: 'owner' });
      });
    } catch (error) {
      if (pgErrorCode(error) === PG.uniqueViolation) throw conflict('That slug is already taken');
      throw error;
    }
  }

  async listForUser(userId: string): Promise<OrganizationWithRole[]> {
    const rows = await asUser(this.deps.db, userId, (tx) =>
      tx.query<OrgRow>(
        `select o.id, o.name, o.slug, o.plan, o.created_at, m.role::text as role
           from public.organizations o
           join public.organization_members m on m.organization_id = o.id and m.user_id = $1
          order by o.name`,
        [userId],
      ),
    );
    return rows.map(toOrg);
  }

  async get(userId: string, organizationId: string): Promise<OrganizationWithRole> {
    const [row] = await asUser(this.deps.db, userId, (tx) =>
      tx.query<OrgRow>(
        `select o.id, o.name, o.slug, o.plan, o.created_at, m.role::text as role
           from public.organizations o
           join public.organization_members m on m.organization_id = o.id and m.user_id = $1
          where o.id = $2`,
        [userId, organizationId],
      ),
    );
    if (!row) throw notFound('Organization');
    return toOrg(row);
  }

  async listMembers(userId: string, organizationId: string): Promise<OrganizationMember[]> {
    const rows = await asUser(this.deps.db, userId, (tx) =>
      tx.query<MemberRow>(
        `select m.organization_id, m.user_id, p.display_name, m.role::text as role, m.created_at
           from public.organization_members m
           left join public.profiles p on p.id = m.user_id
          where m.organization_id = $1
          order by m.role, p.display_name nulls last`,
        [organizationId],
      ),
    );
    // RLS returns nothing for non-members; make that indistinguishable from "no such org".
    if (rows.length === 0) throw notFound('Organization');
    return rows.map(toMember);
  }

  async addMember(
    actorId: string,
    organizationId: string,
    input: { email: string; role: Role },
  ): Promise<OrganizationMember> {
    const actorRole = await this.getRole(actorId, organizationId);
    if (!actorRole) throw notFound('Organization');
    if (!canManageMember(actorRole, null, input.role)) throw forbidden();

    const userId = await userIdByEmail(this.deps.db, input.email);
    if (!userId) throw notFound('Account');
    const user = { id: userId };
    try {
      const [row] = await this.deps.db.query<MemberRow>(
        `with inserted as (
           insert into public.organization_members (organization_id, user_id, role)
           values ($1, $2, $3::public.org_role)
           returning organization_id, user_id, role, created_at
         )
         select i.organization_id, i.user_id, p.display_name, i.role::text as role, i.created_at
           from inserted i left join public.profiles p on p.id = i.user_id`,
        [organizationId, user.id, input.role],
      );
      if (!row) throw new Error('Insert returned no row');
      return toMember(row);
    } catch (error) {
      if (pgErrorCode(error) === PG.uniqueViolation) throw conflict('Already a member');
      throw error;
    }
  }

  async updateMemberRole(
    actorId: string,
    organizationId: string,
    memberId: string,
    role: Role,
  ): Promise<OrganizationMember> {
    const actorRole = await this.getRole(actorId, organizationId);
    if (!actorRole) throw notFound('Organization');
    const currentRole = await this.getRole(memberId, organizationId);
    if (!currentRole) throw notFound('Member');
    if (!canManageMember(actorRole, currentRole, role)) throw forbidden();
    try {
      const [row] = await this.deps.db.query<MemberRow>(
        `with updated as (
           update public.organization_members set role = $3::public.org_role
            where organization_id = $1 and user_id = $2
           returning organization_id, user_id, role, created_at
         )
         select u.organization_id, u.user_id, p.display_name, u.role::text as role, u.created_at
           from updated u left join public.profiles p on p.id = u.user_id`,
        [organizationId, memberId, role],
      );
      if (!row) throw notFound('Member');
      return toMember(row);
    } catch (error) {
      if (pgErrorCode(error) === PG.checkViolation) {
        throw conflict('An organization must keep at least one owner');
      }
      throw error;
    }
  }

  /** Members may always leave; otherwise the actor must be allowed to manage the member. */
  async removeMember(actorId: string, organizationId: string, memberId: string): Promise<void> {
    const actorRole = await this.getRole(actorId, organizationId);
    if (!actorRole) throw notFound('Organization');
    const currentRole = await this.getRole(memberId, organizationId);
    if (!currentRole) throw notFound('Member');
    if (actorId !== memberId && !canManageMember(actorRole, currentRole, null)) throw forbidden();
    try {
      await this.deps.db.transaction(async (tx) => {
        await tx.query(
          'delete from public.organization_members where organization_id = $1 and user_id = $2',
          [organizationId, memberId],
        );
        // Grants on this organisation's devices go with the membership.
        await tx.query(
          `delete from public.device_permissions dp
            using public.devices d
            where dp.device_id = d.id and d.organization_id = $1 and dp.user_id = $2`,
          [organizationId, memberId],
        );
      });
    } catch (error) {
      if (pgErrorCode(error) === PG.checkViolation) {
        throw conflict('An organization must keep at least one owner');
      }
      throw error;
    }
  }
}
