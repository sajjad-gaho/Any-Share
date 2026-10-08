-- Phase 3: peer-to-peer session support.
--
--  * Audit actions for transfers that happen over WebRTC DataChannels (the
--    server never sees file or clipboard contents, only these events).
--  * Short-lived session authorization: an approved session that does not
--    connect within the window is expired/failed by the signaling sweeper.

alter type public.audit_action add value if not exists 'FILE_TRANSFER_STARTED';
alter type public.audit_action add value if not exists 'FILE_TRANSFER_COMPLETED';
alter type public.audit_action add value if not exists 'FILE_TRANSFER_CANCELLED';
alter type public.audit_action add value if not exists 'CLIPBOARD_TRANSFERRED';

-- Sessions stuck before CONNECTED: SIGNALING -> EXPIRED, CONNECTING -> FAILED.
-- Uses updated_at, which every state transition bumps.
create function public.expire_stale_sessions(connect_timeout_seconds integer)
returns table (session_id uuid, controller_user_id uuid, target_device_id uuid, state public.session_state)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if connect_timeout_seconds < 10 then
    raise exception 'connect timeout too short' using errcode = 'check_violation';
  end if;
  return query
  with expired as (
    update public.sessions s
       set state = case when s.state = 'SIGNALING' then 'EXPIRED'::public.session_state
                        else 'FAILED'::public.session_state end,
           failure_reason = case when s.state = 'SIGNALING' then 'authorization_expired'
                                 else 'connect_timeout' end
     where s.state in ('SIGNALING', 'CONNECTING')
       and s.updated_at < now() - make_interval(secs => connect_timeout_seconds)
    returning s.id, s.controller_user_id, s.target_device_id, s.state
  )
  select e.id, e.controller_user_id, e.target_device_id, e.state from expired e;
end;
$$;

-- Supabase grants EXECUTE on new public functions to client roles by default.
revoke execute on function public.expire_stale_sessions(integer) from public, anon, authenticated;
