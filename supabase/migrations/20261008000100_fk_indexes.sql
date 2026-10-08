-- Phase 4: covering indexes for foreign keys reported by the Supabase
-- performance advisor (unindexed_foreign_keys). Without them, deleting or
-- updating a referenced row (a device, a user, an organization) scans the
-- referencing table.
--
-- Additive and idempotent. Rollback: drop the indexes (see bottom).

create index if not exists connection_requests_controller_device_id_idx
  on public.connection_requests (controller_device_id);
create index if not exists connection_requests_responded_by_idx
  on public.connection_requests (responded_by);
create index if not exists device_permissions_granted_by_idx
  on public.device_permissions (granted_by);
create index if not exists organizations_created_by_idx
  on public.organizations (created_by);
create index if not exists session_permissions_granted_by_idx
  on public.session_permissions (granted_by);
create index if not exists sessions_controller_device_id_idx
  on public.sessions (controller_device_id);
create index if not exists sessions_organization_id_idx
  on public.sessions (organization_id);

-- Rollback:
--   drop index if exists public.connection_requests_controller_device_id_idx,
--     public.connection_requests_responded_by_idx, public.device_permissions_granted_by_idx,
--     public.organizations_created_by_idx, public.session_permissions_granted_by_idx,
--     public.sessions_controller_device_id_idx, public.sessions_organization_id_idx;
