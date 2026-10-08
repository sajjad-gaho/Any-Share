-- Phase 2: integrity triggers and authorisation helpers.
--
-- All functions pin `search_path = ''` and fully qualify names, so a malicious
-- object in another schema can never shadow what they reference.

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'organizations', 'organization_members', 'devices', 'device_permissions',
    'connection_requests', 'sessions'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function private.set_updated_at()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles are created with the auth user.
-- ---------------------------------------------------------------------------

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text := nullif(btrim(new.raw_user_meta_data ->> 'display_name'), '');
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(requested_name, 64));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Organisations always keep at least one owner.
-- ---------------------------------------------------------------------------

create function private.ensure_org_has_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Cascading delete of the whole organisation: nothing to protect.
  if not exists (select 1 from public.organizations where id = old.organization_id) then
    return null;
  end if;
  if old.role = 'owner' and not exists (
    select 1 from public.organization_members
    where organization_id = old.organization_id and role = 'owner'
  ) then
    raise exception 'An organization must keep at least one owner'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create trigger ensure_org_has_owner
  after update of role or delete on public.organization_members
  for each row execute function private.ensure_org_has_owner();

-- ---------------------------------------------------------------------------
-- Session state machine. Mirrors SESSION_TRANSITIONS in
-- packages/shared/src/session-state.ts (kept in sync by a test).
-- ---------------------------------------------------------------------------

create function public.session_transition_allowed(
  from_state public.session_state,
  to_state public.session_state
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case from_state
    when 'IDLE' then to_state in ('REQUESTING')
    when 'REQUESTING' then to_state in ('APPROVAL_PENDING', 'AUTHORIZING', 'ENDED', 'FAILED', 'EXPIRED')
    when 'APPROVAL_PENDING' then to_state in ('AUTHORIZING', 'ENDED', 'FAILED', 'EXPIRED')
    when 'AUTHORIZING' then to_state in ('SIGNALING', 'ENDING', 'FAILED')
    when 'SIGNALING' then to_state in ('CONNECTING', 'ENDING', 'FAILED', 'EXPIRED')
    when 'CONNECTING' then to_state in ('CONNECTED', 'RECONNECTING', 'ENDING', 'FAILED')
    when 'CONNECTED' then to_state in ('RECONNECTING', 'ENDING', 'FAILED')
    when 'RECONNECTING' then to_state in ('CONNECTING', 'CONNECTED', 'ENDING', 'FAILED', 'EXPIRED')
    when 'ENDING' then to_state in ('ENDED', 'FAILED')
    else false
  end;
$$;

create function private.enforce_session_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state not in ('IDLE', 'REQUESTING') then
      raise exception 'A session must start in IDLE or REQUESTING, not %', new.state
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.controller_user_id is distinct from old.controller_user_id
     or new.target_device_id is distinct from old.target_device_id
     or new.connection_request_id is distinct from old.connection_request_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Session participants are immutable' using errcode = 'check_violation';
  end if;

  if new.state is distinct from old.state then
    if not public.session_transition_allowed(old.state, new.state) then
      raise exception 'Invalid session transition % -> %', old.state, new.state
        using errcode = 'check_violation';
    end if;
    if new.state = 'CONNECTED' and old.connected_at is null then
      new.connected_at := now();
    end if;
    if new.state in ('ENDED', 'FAILED', 'EXPIRED') then
      new.ended_at := coalesce(new.ended_at, now());
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_session_transition
  before insert or update on public.sessions
  for each row execute function private.enforce_session_transition();

-- ---------------------------------------------------------------------------
-- Connection requests: pending -> one terminal status, never back.
-- ---------------------------------------------------------------------------

create function private.enforce_connection_request_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'A connection request must be created pending' using errcode = 'check_violation';
    end if;
    if new.expires_at > now() + interval '10 minutes' then
      raise exception 'Connection requests may live at most 10 minutes' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.controller_user_id is distinct from old.controller_user_id
     or new.target_device_id is distinct from old.target_device_id
     or new.requested_permissions is distinct from old.requested_permissions
     or new.expires_at is distinct from old.expires_at then
    raise exception 'Connection request details are immutable' using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'Connection request is already %', old.status using errcode = 'check_violation';
    end if;
    if new.status = 'approved' and old.expires_at <= now() then
      raise exception 'Connection request has expired' using errcode = 'check_violation';
    end if;
    new.responded_at := coalesce(new.responded_at, now());
  end if;
  return new;
end;
$$;

create trigger enforce_connection_request_transition
  before insert or update on public.connection_requests
  for each row execute function private.enforce_connection_request_transition();

-- ---------------------------------------------------------------------------
-- Audit log is append-only.
-- ---------------------------------------------------------------------------

create function private.prevent_audit_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end;
$$;

create trigger prevent_audit_update
  before update on public.audit_logs
  for each row execute function private.prevent_audit_update();

-- ---------------------------------------------------------------------------
-- Request expiry. Called by the signaling service's sweeper every few seconds;
-- can also be scheduled with pg_cron:
--   select cron.schedule('expire-connection-requests', '* * * * *',
--                        'select public.expire_connection_requests()');
-- ---------------------------------------------------------------------------

create function public.expire_connection_requests()
returns table (request_id uuid, session_id uuid, controller_user_id uuid, target_device_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with expired as (
    update public.connection_requests cr
       set status = 'expired'
     where cr.status = 'pending' and cr.expires_at <= now()
    returning cr.id, cr.controller_user_id, cr.target_device_id
  ), sessions_expired as (
    update public.sessions s
       set state = 'EXPIRED', failure_reason = 'expired'
      from expired e
     where s.connection_request_id = e.id
       and s.state in ('REQUESTING', 'APPROVAL_PENDING')
    returning s.id, s.connection_request_id
  )
  select e.id, se.id, e.controller_user_id, e.target_device_id
    from expired e
    left join sessions_expired se on se.connection_request_id = e.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authorisation helpers for RLS. SECURITY DEFINER so policies can consult
-- membership tables without recursing into those tables' own policies. Each
-- takes the caller from auth.uid(); none accepts a user id from the client.
-- ---------------------------------------------------------------------------

create function private.org_role(org uuid)
returns public.org_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.organization_members m
   where m.organization_id = org and m.user_id = (select auth.uid());
$$;

create function private.is_org_member(org uuid, min_role public.org_role default 'user')
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.org_role(org) <= min_role, false);
$$;

create function private.shares_org_with(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members mine
      join public.organization_members theirs using (organization_id)
     where mine.user_id = (select auth.uid()) and theirs.user_id = other_user
  );
$$;

create function private.can_manage_device(device uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.devices d
     where d.id = device
       and (
         d.owner_id = (select auth.uid())
         or (d.organization_id is not null and private.is_org_member(d.organization_id, 'admin'))
       )
  );
$$;

create function private.can_view_device(device uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.devices d
     where d.id = device
       and (
         d.owner_id = (select auth.uid())
         or (d.organization_id is not null and private.is_org_member(d.organization_id, 'operator'))
         or (
           d.organization_id is not null
           and private.is_org_member(d.organization_id, 'user')
           and exists (
             select 1 from public.device_permissions p
              where p.device_id = d.id and p.user_id = (select auth.uid())
           )
         )
       )
  );
$$;

create function private.can_view_session(session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sessions s
     where s.id = session
       and (s.controller_user_id = (select auth.uid()) or private.can_manage_device(s.target_device_id))
  );
$$;

-- Lets a client see *whether* a device it can view has an access password,
-- without granting any access to device_credentials itself.
create function private.device_has_access_password(device uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_device(device) and exists (
    select 1 from public.device_credentials c
     where c.device_id = device and c.kind = 'access_password' and c.revoked_at is null
  );
$$;
