-- Phase 2: row level security and grants.
--
-- Model
--   * `anon` gets nothing.
--   * `authenticated` may SELECT what it is authorised to see (policies below)
--     and UPDATE its own profile's display fields. Every other write goes
--     through the API, which authorises server-side and writes with a
--     privileged connection.
--   * `device_credentials` is invisible to every client role.
--
-- Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated; we revoke first so RLS is never the only line of defence.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on schema private from public, anon;

grant usage on schema private to authenticated;
grant execute on function
  private.org_role(uuid),
  private.is_org_member(uuid, public.org_role),
  private.shares_org_with(uuid),
  private.can_manage_device(uuid),
  private.can_view_device(uuid),
  private.can_view_session(uuid),
  private.device_has_access_password(uuid)
  to authenticated;

grant select on
  public.profiles,
  public.organizations,
  public.organization_members,
  public.devices,
  public.device_permissions,
  public.connection_requests,
  public.sessions,
  public.session_permissions,
  public.audit_logs
  to authenticated;

grant update (display_name, avatar_url) on public.profiles to authenticated;

-- Pure function, safe for anyone (used by the API and tests).
grant execute on function public.session_transition_allowed(public.session_state, public.session_state)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. The API's privileged connection (table owner) is not
-- subject to it; reads on behalf of a user switch to `authenticated` first
-- (see packages/backend/src/db), so RLS applies to them as well.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'organizations', 'organization_members', 'devices', 'device_credentials',
    'device_permissions', 'connection_requests', 'sessions', 'session_permissions', 'audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Policies. `(select auth.uid())` is wrapped so Postgres evaluates it once per
-- statement instead of once per row.
-- ---------------------------------------------------------------------------

-- profiles: yourself, and people you share an organisation with.
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.shares_org_with(id));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- organizations / members: only organisations you belong to.
create policy organizations_select on public.organizations
  for select to authenticated
  using (private.is_org_member(id));

create policy organization_members_select on public.organization_members
  for select to authenticated
  using (private.is_org_member(organization_id));

-- devices: your own, your organisation's (operator and above), or ones you were
-- explicitly granted. Another user's personal device is never visible.
create policy devices_select on public.devices
  for select to authenticated
  using (private.can_view_device(id));

-- device_credentials: no policy => no rows for any client role.

create policy device_permissions_select on public.device_permissions
  for select to authenticated
  using (user_id = (select auth.uid()) or private.can_manage_device(device_id));

-- connection requests / sessions: the controller, or whoever manages the target device.
create policy connection_requests_select on public.connection_requests
  for select to authenticated
  using (
    controller_user_id = (select auth.uid()) or private.can_manage_device(target_device_id)
  );

create policy sessions_select on public.sessions
  for select to authenticated
  using (
    controller_user_id = (select auth.uid()) or private.can_manage_device(target_device_id)
  );

create policy session_permissions_select on public.session_permissions
  for select to authenticated
  using (private.can_view_session(session_id));

-- audit logs: your own actions, plus your organisation's if you are admin or owner.
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    actor_user_id = (select auth.uid())
    or (organization_id is not null and private.is_org_member(organization_id, 'admin'))
  );
