-- Legacy clients have used both GK + seven and GK + eight digit player IDs.
-- New accounts continue to issue the seven-digit form; this only keeps an
-- imported historical ID from being rejected by the secure provisioning RPC.
create or replace function public.create_player_profile(
  p_actor_id uuid,
  p_auth_user_id uuid,
  p_login_id text,
  p_auth_email text,
  p_full_name text,
  p_starting_play_points bigint,
  p_note text default null,
  p_idempotency_key text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_key text;
begin
  perform public.assert_active_admin(p_actor_id);
  if trim(p_login_id) !~ '^GK[0-9]{7,8}$' then
    raise exception 'Player login ID must be GK followed by seven or eight digits' using errcode = '22023';
  end if;
  if p_starting_play_points < 0 or p_starting_play_points > 1000000 then
    raise exception 'Starting virtual play points must be between 0 and 1000000' using errcode = '22023';
  end if;

  insert into public.profiles(
    id, login_id, auth_email, account_kind, status, display_name, full_name,
    email_verified, accepted_terms, play_points_balance
  ) values (
    p_auth_user_id, trim(p_login_id), lower(trim(p_auth_email)), 'PLAYER', 'ACTIVE',
    trim(p_full_name), trim(p_full_name), true, true, 0
  ) returning * into v_profile;

  if p_starting_play_points > 0 then
    v_key := coalesce(nullif(trim(p_idempotency_key), ''), 'player-create:' || p_auth_user_id::text);
    perform public.adjust_play_points(
      p_actor_id, p_auth_user_id, p_starting_play_points, 'WELCOME_BONUS', v_key,
      'PLAYER_PROVISIONING', p_auth_user_id::text,
      coalesce(p_note, 'Virtual welcome play points')
    );
    select * into v_profile from public.profiles where id = p_auth_user_id;
  end if;

  perform public.audit_admin_action(
    p_actor_id, 'PLAYER_CREATED', 'PLAYER', p_auth_user_id::text, null,
    jsonb_build_object('login_id', trim(p_login_id), 'starting_play_points', p_starting_play_points), p_note
  );
  return v_profile;
exception when unique_violation then
  raise exception 'That player login ID is already in use' using errcode = '23505';
end;
$$;

revoke all on function public.create_player_profile(uuid, uuid, text, text, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.create_player_profile(uuid, uuid, text, text, text, bigint, text, text)
  to service_role;
