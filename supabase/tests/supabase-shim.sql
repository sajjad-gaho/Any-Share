-- TEST ONLY. Never apply to a real project.
--
-- Recreates the small part of a Supabase database the migrations depend on, so
-- they can run inside PGlite (embedded Postgres) in unit/integration tests:
--   * the anon / authenticated / service_role roles,
--   * the auth schema with auth.users and auth.uid() / auth.jwt(),
--   * Supabase's default privileges on the public schema (which our migrations
--     must explicitly revoke — so the tests prove the revokes work).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Supabase Auth's refresh-token sessions; the API checks the JWT's session_id
-- here so a logged-out access token stops working before it expires.
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  not_after timestamptz
);

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create function auth.role() returns text
language sql stable as $$
  select auth.jwt() ->> 'role';
$$;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
