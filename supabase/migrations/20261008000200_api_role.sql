-- Phase 4: a least-privilege database role for apps/api and apps/signaling.
--
-- Today the services connect as `postgres`, which can change the schema, turn
-- off RLS, read every Supabase schema (auth, storage, vault, ...) and rewrite
-- the audit log. A leaked DATABASE_URL or an injection bug would expose all of
-- that. `kestrel_api` gets exactly what the services use:
--
--   * row access to the application tables (BYPASSRLS, like today: the
--     services authorize in code and use `asUser` -> role `authenticated`
--     where RLS is the gate);
--   * INSERT/SELECT only on audit_logs: no UPDATE or DELETE, so the API cannot
--     rewrite history (a trigger already blocks updates; this is the grant level);
--   * the functions the services call, plus two narrow lookups into auth.*
--     (is a sign-in session still active; user id for an e-mail address);
--   * no DDL: it owns nothing and has no CREATE on any schema.
--
-- The password is NOT set here (migrations are committed). After applying:
--   alter role kestrel_api password '<generated secret>';   -- via the SQL editor
-- then point DATABASE_URL at `kestrel_api.<project-ref>` on the session pooler.
-- Rollback: switch DATABASE_URL back to postgres, then run the bottom block.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kestrel_api') then
    create role kestrel_api login bypassrls noinherit nocreatedb nocreaterole;
  end if;
end
$$;

-- `asUser` runs `set local role authenticated`: allow SET, but inherit nothing.
grant authenticated to kestrel_api with inherit false, set true;

grant usage on schema public, private to kestrel_api;

grant select, insert, update, delete on
  public.profiles,
  public.organizations,
  public.organization_members,
  public.devices,
  public.device_credentials,
  public.device_permissions,
  public.sessions,
  public.session_permissions,
  public.connection_requests
to kestrel_api;

-- Append-only from the services' point of view.
grant select, insert on public.audit_logs to kestrel_api;

grant execute on function
  public.expire_connection_requests(),
  public.expire_stale_sessions(integer),
  public.session_transition_allowed(public.session_state, public.session_state),
  private.device_has_access_password(uuid),
  private.can_manage_device(uuid),
  private.can_view_device(uuid),
  private.can_view_session(uuid),
  private.is_org_member(uuid, public.org_role),
  private.org_role(uuid),
  private.shares_org_with(uuid),
  private.is_valid_permission_set(public.session_permission[])
to kestrel_api;

-- Logout takes effect immediately (AuthService checks auth.sessions) and
-- members are added by e-mail (OrganizationsService reads auth.users).
-- Supabase does not let `postgres` grant access to the auth schema, so these
-- two narrow SECURITY DEFINER functions answer exactly those questions. The
-- services call them when present and fall back to querying auth.* directly
-- (as `postgres`) otherwise.
create or replace function private.auth_session_active(session uuid, owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions
     where id = session and user_id = owner
       and (not_after is null or not_after > now())
  );
$$;

create or replace function private.user_id_by_email(address text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(address) limit 1;
$$;

revoke all on function private.auth_session_active(uuid, uuid) from public, anon, authenticated;
revoke all on function private.user_id_by_email(text) from public, anon, authenticated;
grant execute on function private.auth_session_active(uuid, uuid) to kestrel_api;
grant execute on function private.user_id_by_email(text) to kestrel_api;

-- Keep statements and idle transactions bounded for this role.
alter role kestrel_api set statement_timeout = '15s';
alter role kestrel_api set idle_in_transaction_session_timeout = '30s';

-- Rollback (after DATABASE_URL no longer uses kestrel_api):
--   revoke all on all tables in schema public from kestrel_api;
--   revoke all on all functions in schema public, private from kestrel_api;
--   revoke usage on schema public, private from kestrel_api;
--   revoke authenticated from kestrel_api;
--   drop function if exists private.auth_session_active(uuid, uuid);
--   drop function if exists private.user_id_by_email(text);
--   drop role kestrel_api;
