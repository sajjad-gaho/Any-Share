-- Phase 2: core schema.
--
-- Conventions
--   * UUID primary keys (gen_random_uuid), timestamptz everywhere, stored in UTC.
--   * Every table gets RLS in 20261003000300_rls.sql. Clients (anon/authenticated)
--     only ever READ through RLS; all writes go through apps/api / apps/signaling,
--     which authorise server-side first.
--   * Secrets never live here in plaintext: device access passwords are Argon2id
--     hashes and device identity is an Ed25519 *public* key.

create schema if not exists private;
comment on schema private is
  'Helper functions used by RLS policies and triggers. Not exposed through the Data API.';

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Declaration order matters: owner < admin < operator < user, so `role <= 'admin'`
-- means "admin or higher".
create type public.org_role as enum ('owner', 'admin', 'operator', 'user');

create type public.session_permission as enum (
  'screen_view', 'mouse', 'keyboard', 'clipboard', 'file_transfer', 'audio', 'remote_control'
);

create type public.session_state as enum (
  'IDLE', 'REQUESTING', 'APPROVAL_PENDING', 'AUTHORIZING', 'SIGNALING', 'CONNECTING',
  'CONNECTED', 'RECONNECTING', 'ENDING', 'ENDED', 'FAILED', 'EXPIRED'
);

create type public.connection_request_status as enum (
  'pending', 'approved', 'rejected', 'expired', 'cancelled'
);

create type public.device_credential_kind as enum ('ed25519_public_key', 'access_password');

create type public.os_family as enum ('windows', 'macos', 'linux', 'android', 'ios');

create type public.audit_action as enum (
  'LOGIN', 'LOGOUT', 'DEVICE_REGISTERED', 'DEVICE_REVOKED', 'CONNECTION_REQUESTED',
  'CONNECTION_APPROVED', 'CONNECTION_REJECTED', 'SESSION_STARTED', 'SESSION_ENDED',
  'PERMISSION_CHANGED'
);

-- A permission set is non-empty, unique, always includes screen_view, and input
-- (mouse/keyboard) requires remote_control. Mirrors permissionSetProblem() in
-- packages/shared.
create function private.is_valid_permission_set(perms public.session_permission[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select perms is not null
    and cardinality(perms) between 1 and 7
    and cardinality(perms) = (select count(distinct p) from unnest(perms) as p)
    and 'screen_view' = any(perms)
    and (
      not (perms && array['mouse', 'keyboard']::public.session_permission[])
      or 'remote_control' = any(perms)
    );
$$;

-- ---------------------------------------------------------------------------
-- Users and organisations
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 64),
  avatar_url text check (avatar_url ~ '^https://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'Public profile for each auth.users row (email stays in auth).';

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  plan text not null default 'free' check (plan in ('free', 'team', 'enterprise')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.org_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_id_idx on public.organization_members (user_id);

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  -- Public 9-digit ID (8 random digits + Luhn check digit). NOT a secret.
  device_code text not null unique check (device_code ~ '^[0-9]{9}$'),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  name text not null check (char_length(name) between 1 and 64),
  os_family public.os_family not null,
  os_version text not null check (char_length(os_version) between 1 and 64),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  require_approval boolean not null default true,
  -- SHA-256 of the registered public key, for display and pinning.
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Presence. `is_online` flips on WebSocket connect/disconnect; `last_seen_at` is
  -- flushed in batches by the signaling service, never once per heartbeat. A
  -- device counts as online only if both agree (see DevicesService), so a crashed
  -- signaling instance cannot leave devices "online" forever.
  is_online boolean not null default false,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index devices_owner_id_idx on public.devices (owner_id);
-- A key pair identifies exactly one live device.
create unique index devices_active_key_idx on public.devices (key_fingerprint)
  where revoked_at is null;
create index devices_organization_id_idx on public.devices (organization_id)
  where organization_id is not null;

create table public.device_credentials (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  kind public.device_credential_kind not null,
  -- ed25519_public_key: base64 SPKI DER. Not secret, but integrity-critical.
  public_key text,
  -- access_password: Argon2id PHC string. Never plaintext.
  secret_hash text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint device_credentials_shape check (
    (kind = 'ed25519_public_key' and public_key ~ '^[A-Za-z0-9+/]{59}=$' and secret_hash is null)
    or (kind = 'access_password' and secret_hash like '$argon2id$%' and public_key is null)
  )
);
-- At most one live credential of each kind per device.
create unique index device_credentials_active_idx
  on public.device_credentials (device_id, kind)
  where revoked_at is null;

create table public.device_permissions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  permissions public.session_permission[] not null
    check (private.is_valid_permission_set(permissions)),
  require_approval boolean not null default true,
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, user_id)
);
create index device_permissions_user_id_idx on public.device_permissions (user_id);

-- ---------------------------------------------------------------------------
-- Connection requests and sessions
-- ---------------------------------------------------------------------------

create table public.connection_requests (
  id uuid primary key default gen_random_uuid(),
  controller_user_id uuid not null references public.profiles (id) on delete cascade,
  controller_device_id uuid references public.devices (id) on delete set null,
  target_device_id uuid not null references public.devices (id) on delete cascade,
  requested_permissions public.session_permission[] not null
    check (private.is_valid_permission_set(requested_permissions)),
  message text check (char_length(message) <= 280),
  status public.connection_request_status not null default 'pending',
  responded_by uuid references public.profiles (id) on delete set null,
  responded_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connection_requests_expiry check (expires_at > created_at),
  constraint connection_requests_not_self check (
    controller_device_id is null or controller_device_id <> target_device_id
  )
);
create index connection_requests_target_idx
  on public.connection_requests (target_device_id, status);
create index connection_requests_controller_idx
  on public.connection_requests (controller_user_id, created_at desc);
create index connection_requests_pending_expiry_idx
  on public.connection_requests (expires_at)
  where status = 'pending';

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  connection_request_id uuid unique references public.connection_requests (id) on delete set null,
  controller_user_id uuid not null references public.profiles (id) on delete cascade,
  controller_device_id uuid references public.devices (id) on delete set null,
  target_device_id uuid not null references public.devices (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  state public.session_state not null default 'IDLE',
  failure_reason text check (char_length(failure_reason) <= 200),
  connected_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_controller_idx on public.sessions (controller_user_id, created_at desc);
create index sessions_target_idx on public.sessions (target_device_id, created_at desc);
create index sessions_live_idx on public.sessions (state)
  where state not in ('ENDED', 'FAILED', 'EXPIRED');

create table public.session_permissions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  permission public.session_permission not null,
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (session_id, permission)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------

-- No foreign keys on purpose: audit records must outlive the users, devices and
-- organisations they mention, and must never be rewritten by an ON DELETE action.
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  actor_user_id uuid,
  actor_device_id uuid,
  action public.audit_action not null,
  target_type text check (
    target_type in ('user', 'device', 'session', 'connection_request', 'organization')
  ),
  target_id text check (char_length(target_id) <= 128),
  -- Flat primitives only; secrets are stripped by the API before insert.
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  ip_address inet,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (organization_id, created_at desc)
  where organization_id is not null;
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);
