import type { Role, User } from '@remote-desktop/shared';
import { asUser } from '../db/types';
import { notFound } from '../errors';
import { toIso, type ServiceDeps } from './context';

interface ProfileRow {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: Date | string;
}

interface MembershipRow {
  organization_id: string;
  name: string;
  role: Role;
}

export class UsersService {
  constructor(private readonly deps: ServiceDeps) {}

  /** The caller's profile and memberships, read under RLS. */
  async getMe(userId: string, email: string | null): Promise<User> {
    return asUser(this.deps.db, userId, async (tx) => {
      const [profile] = await tx.query<ProfileRow>(
        'select id, display_name, avatar_url, created_at from public.profiles where id = $1',
        [userId],
      );
      if (!profile) throw notFound('Profile');
      const memberships = await tx.query<MembershipRow>(
        `select m.organization_id, o.name, m.role::text as role
           from public.organization_members m
           join public.organizations o on o.id = m.organization_id
          where m.user_id = $1
          order by o.name`,
        [userId],
      );
      return {
        id: profile.id,
        email: email ?? '',
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        createdAt: toIso(profile.created_at),
        memberships: memberships.map((m) => ({
          organizationId: m.organization_id,
          organizationName: m.name,
          role: m.role,
        })),
      };
    });
  }

  /**
   * Runs as the user: the RLS policy and column grant on `profiles` are what
   * restrict this to the caller's own display fields.
   */
  async updateProfile(userId: string, input: { displayName: string }, email: string | null) {
    await asUser(this.deps.db, userId, (tx) =>
      tx.query('update public.profiles set display_name = $2 where id = $1', [
        userId,
        input.displayName,
      ]),
    );
    return this.getMe(userId, email);
  }

  async getDisplayName(userId: string): Promise<string | null> {
    const [row] = await this.deps.db.query<{ display_name: string | null }>(
      'select display_name from public.profiles where id = $1',
      [userId],
    );
    return row?.display_name ?? null;
  }
}
