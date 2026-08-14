-- MyDGP Supabase control plane
--
-- This is a virtual-points-only control plane for mydgp.casino/admin.  The
-- browser has no table or RPC grants: all privileged commands go through the
-- Supabase Edge API using the service role, and each change is recorded.

create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.account_kind as enum ('PLAYER', 'ADMIN');
create type public.account_status as enum (
  'VERIFIED', 'PROFILE_SUBMITTED', 'PENDING', 'PENDING_AUDIT',
  'ACTIVE', 'REJECTED', 'SUSPENDED'
);
create type public.admin_level as enum ('PRIMARY', 'OPERATOR');
create type public.play_point_kind as enum (
  'WELCOME_BONUS', 'ADMIN_ADJUSTMENT', 'REQUEST_ALLOCATION', 'STAKE',
  'PRIZE', 'REFUND', 'MIGRATION_OPENING'
);
create type public.request_status as enum ('PENDING', 'APPROVED', 'DENIED');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  legacy_id text unique,
  login_id citext not null unique,
  auth_email citext not null unique,
  account_kind public.account_kind not null,
  status public.account_status not null default 'PENDING',
  display_name text,
  full_name text,
  country text,
  date_of_birth date,
  phone text,
  avatar text,
  email_verified boolean not null default false,
  accepted_terms boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  -- Player balances are virtual play points only. Administrators never have a
  -- balance, which prevents an operator identity from being used to play.
  play_points_balance bigint,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_login_at timestamptz,
  legacy_metadata jsonb not null default '{}'::jsonb,
  check (
    (account_kind = 'PLAYER' and play_points_balance is not null and play_points_balance >= 0)
    or (account_kind = 'ADMIN' and play_points_balance is null)
  )
);

create table public.admin_accounts (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  admin_level public.admin_level not null,
  created_by uuid references public.profiles(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (
    (admin_level = 'PRIMARY' and created_by is null)
    or (admin_level = 'OPERATOR' and created_by is not null)
  )
);

create unique index admin_accounts_one_primary
  on public.admin_accounts (admin_level)
  where admin_level = 'PRIMARY';

create table public.play_point_ledger (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete restrict,
  delta bigint not null check (delta <> 0),
  balance_after bigint not null check (balance_after >= 0),
  entry_sequence bigint not null,
  kind public.play_point_kind not null,
  idempotency_key text not null check (char_length(trim(idempotency_key)) >= 8),
  reference_type text,
  reference_id text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (player_id, idempotency_key),
  unique (player_id, entry_sequence)
);

create table public.play_point_requests (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  player_id uuid not null references public.profiles(id) on delete restrict,
  amount bigint not null check (amount > 0),
  note text,
  status public.request_status not null default 'PENDING',
  admin_note text,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  legacy_metadata jsonb not null default '{}'::jsonb
);

create table public.signup_requests (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  full_name text not null,
  email citext not null,
  date_of_birth date,
  phone text,
  country text,
  referral_code text,
  status public.request_status not null default 'PENDING',
  assigned_login_id citext,
  admin_note text,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  legacy_metadata jsonb not null default '{}'::jsonb
);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  user_id uuid not null references public.profiles(id) on delete restrict,
  sender public.account_kind not null,
  body text not null check (char_length(body) between 1 and 2000),
  read_admin boolean not null default false,
  read_user boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  user_id uuid not null references public.profiles(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 2000),
  type text not null default 'INFO',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  slug text not null unique,
  name text not null,
  category text,
  tagline text,
  description text,
  status text not null default 'ENABLED'
    check (status in ('COMING_SOON', 'ENABLED', 'DISABLED', 'MAINTENANCE', 'UPDATE_REQUIRED', 'RETIRED')),
  featured boolean not null default false,
  art jsonb not null default '{}'::jsonb,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 5000),
  pinned boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table public.system_config (
  key text primary key check (key = 'main'),
  maintenance_mode boolean not null default false,
  maintenance_message text,
  min_client_version text not null default '1.0.0',
  welcome_play_points bigint not null default 1000 check (welcome_play_points between 0 and 1000000),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  legacy_metadata jsonb not null default '{}'::jsonb
);

create table public.compliance_config (
  key text primary key default 'main' check (key = 'main'),
  market_mode text not null default 'OFF' check (market_mode in ('OFF', 'ALLOW', 'BLOCK')),
  markets text[] not null default '{}'::text[],
  min_age integer not null default 18 check (min_age between 18 and 30),
  min_age_by_country jsonb not null default '{}'::jsonb,
  enforce_market_on_login boolean not null default false,
  require_age_verification boolean not null default false,
  reactivation_cooling_hours integer not null default 24 check (reactivation_cooling_hours between 0 and 168),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create table public.player_limits (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('SESSION_POINTS', 'DAILY_POINTS')),
  amount bigint not null check (amount >= 0),
  effective_from timestamptz,
  pending_amount bigint check (pending_amount >= 0),
  pending_effective_from timestamptz,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  unique (player_id, kind)
);

create table public.exclusions (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  player_id uuid not null references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('BREAK', 'SELF_EXCLUSION')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'LIFTED', 'EXPIRED')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  source text not null check (source in ('PLAYER', 'ADMIN')),
  reason text,
  lifted_at timestamptz,
  lifted_by uuid references public.profiles(id) on delete restrict,
  lift_reason text,
  created_at timestamptz not null default now()
);

create table public.admin_audit (
  id bigint generated always as identity primary key,
  request_id uuid not null default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete restrict,
  action text not null,
  target_type text not null,
  target_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now()
);

-- Each imported BSON document is preserved verbatim first. This provides a
-- lossless rollback/audit record even when a legacy game record has no direct
-- equivalent in the virtual-points control plane yet.
create table public.legacy_documents (
  collection_name text not null check (collection_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  legacy_key text not null,
  document jsonb not null,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  primary key (collection_name, legacy_key)
);

create table public.legacy_identity_map (
  legacy_collection text not null,
  legacy_key text not null,
  target_table text not null,
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (legacy_collection, legacy_key),
  unique (target_table, target_id)
);

create table public.migration_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  status text not null default 'STARTED' check (status in ('STARTED', 'ARCHIVED', 'MATERIALIZED', 'VALIDATED', 'FAILED')),
  manifest jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text
);

create index profiles_kind_status_idx on public.profiles(account_kind, status);
create index play_point_ledger_player_created_idx on public.play_point_ledger(player_id, created_at desc);
create index play_point_requests_status_created_idx on public.play_point_requests(status, created_at desc);
create index support_messages_user_created_idx on public.support_messages(user_id, created_at);
create index notifications_user_created_idx on public.notifications(user_id, created_at desc);
create index exclusions_player_active_idx on public.exclusions(player_id, status, created_at desc);

create or replace function public.assert_active_admin(p_admin_id uuid)
returns public.admin_accounts
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_admin public.admin_accounts;
begin
  select a.* into v_admin
  from public.admin_accounts a
  join public.profiles p on p.id = a.user_id
  where a.user_id = p_admin_id
    and p.account_kind = 'ADMIN'
    and p.status = 'ACTIVE'
    and a.revoked_at is null;
  if not found then
    raise exception 'Administrator access is disabled' using errcode = '42501';
  end if;
  return v_admin;
end;
$$;

create or replace function public.assert_primary_admin(p_admin_id uuid)
returns public.admin_accounts
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_admin public.admin_accounts;
begin
  select * into v_admin
  from public.assert_active_admin(p_admin_id)
  where admin_level = 'PRIMARY';
  if not found then
    raise exception 'Primary administrator access required' using errcode = '42501';
  end if;
  return v_admin;
end;
$$;

create or replace function public.audit_admin_action(
  p_actor_id uuid,
  p_action text,
  p_target_type text,
  p_target_id text default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns void
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.admin_audit(
    actor_id, action, target_type, target_id, before_state, after_state, reason
  ) values (
    p_actor_id, p_action, p_target_type, p_target_id, p_before, p_after, p_reason
  );
$$;

create or replace function public.require_player_profile(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = p_player_id and account_kind = 'PLAYER'
  ) then
    raise exception 'Player account required' using errcode = '23514';
  end if;
end;
$$;

create or replace function public.guard_play_point_request_player()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.require_player_profile(new.player_id);
  return new;
end;
$$;

create trigger play_point_requests_player_only
before insert or update of player_id on public.play_point_requests
for each row execute function public.guard_play_point_request_player();

create or replace function public.guard_play_points_balance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.play_points_balance is distinct from new.play_points_balance
    and current_setting('app.play_points_mutation', true) is distinct from 'on' then
    raise exception 'Virtual play-point balances can only change through the ledger' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger profiles_play_points_ledger_only
before update of play_points_balance on public.profiles
for each row execute function public.guard_play_points_balance();

create or replace function public.adjust_play_points(
  p_actor_id uuid,
  p_player_id uuid,
  p_delta bigint,
  p_kind public.play_point_kind,
  p_idempotency_key text,
  p_reference_type text default null,
  p_reference_id text default null,
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(ledger_id uuid, balance_after bigint, duplicate boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_player public.profiles;
  v_existing public.play_point_ledger;
  v_new_balance bigint;
  v_ledger_id uuid;
  v_entry_sequence bigint;
begin
  perform public.assert_active_admin(p_actor_id);
  if p_delta = 0 then
    raise exception 'Play-point adjustment cannot be zero' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;

  -- Locking the player first serializes both balance changes and duplicate
  -- retries, so an interrupted browser request can never issue twice.
  select * into v_player from public.profiles
  where id = p_player_id and account_kind = 'PLAYER'
  for update;
  if not found then
    raise exception 'Player not found' using errcode = 'P0001';
  end if;

  select * into v_existing from public.play_point_ledger
  where player_id = p_player_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.delta <> p_delta
      or v_existing.kind <> p_kind
      or v_existing.reference_type is distinct from p_reference_type
      or v_existing.reference_id is distinct from p_reference_id then
      raise exception 'Idempotency key was already used for a different adjustment' using errcode = '22023';
    end if;
    return query select v_existing.id, v_existing.balance_after, true;
    return;
  end if;

  v_new_balance := v_player.play_points_balance + p_delta;
  if v_new_balance < 0 then
    raise exception 'Insufficient virtual play points' using errcode = '22003';
  end if;

  perform set_config('app.play_points_mutation', 'on', true);
  update public.profiles
  set play_points_balance = v_new_balance
  where id = p_player_id;

  select coalesce(max(entry_sequence), 0) + 1 into v_entry_sequence
  from public.play_point_ledger
  where player_id = p_player_id;

  insert into public.play_point_ledger(
    player_id, actor_id, delta, balance_after, entry_sequence, kind, idempotency_key,
    reference_type, reference_id, note, metadata
  ) values (
    p_player_id, p_actor_id, p_delta, v_new_balance, v_entry_sequence, p_kind, trim(p_idempotency_key),
    p_reference_type, p_reference_id, p_note, coalesce(p_metadata, '{}'::jsonb)
  ) returning id into v_ledger_id;

  perform public.audit_admin_action(
    p_actor_id, 'PLAY_POINTS_ADJUSTED', 'PLAYER', p_player_id::text, null,
    jsonb_build_object('delta', p_delta, 'balance_after', v_new_balance, 'kind', p_kind), p_note
  );
  return query select v_ledger_id, v_new_balance, false;
end;
$$;

-- The future game runtime gets a deliberately narrow settlement entry point.
-- It cannot create administrator actions or use administrative adjustment
-- kinds, and it remains callable only by the server-side service role.
create or replace function public.apply_game_play_points(
  p_player_id uuid,
  p_delta bigint,
  p_kind public.play_point_kind,
  p_idempotency_key text,
  p_game_slug text,
  p_round_id text,
  p_note text default null
)
returns table(ledger_id uuid, balance_after bigint, duplicate boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_player public.profiles;
  v_existing public.play_point_ledger;
  v_new_balance bigint;
  v_ledger_id uuid;
  v_entry_sequence bigint;
begin
  if p_kind not in ('STAKE', 'PRIZE', 'REFUND') then
    raise exception 'Invalid game settlement kind' using errcode = '22023';
  end if;
  if (p_kind = 'STAKE' and p_delta >= 0) or (p_kind in ('PRIZE', 'REFUND') and p_delta <= 0) then
    raise exception 'Game settlement amount has an invalid sign' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;

  select * into v_player from public.profiles
  where id = p_player_id and account_kind = 'PLAYER' and status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'Active player not found' using errcode = 'P0001';
  end if;
  select * into v_existing from public.play_point_ledger
  where player_id = p_player_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.delta <> p_delta or v_existing.kind <> p_kind
      or v_existing.reference_type <> 'GAME_ROUND'
      or v_existing.reference_id is distinct from p_round_id then
      raise exception 'Idempotency key was already used for a different settlement' using errcode = '22023';
    end if;
    return query select v_existing.id, v_existing.balance_after, true;
    return;
  end if;

  v_new_balance := v_player.play_points_balance + p_delta;
  if v_new_balance < 0 then
    raise exception 'Insufficient virtual play points' using errcode = '22003';
  end if;
  perform set_config('app.play_points_mutation', 'on', true);
  update public.profiles set play_points_balance = v_new_balance where id = p_player_id;
  select coalesce(max(entry_sequence), 0) + 1 into v_entry_sequence
  from public.play_point_ledger where player_id = p_player_id;
  insert into public.play_point_ledger(
    player_id, actor_id, delta, balance_after, entry_sequence, kind, idempotency_key,
    reference_type, reference_id, note, metadata
  ) values (
    p_player_id, null, p_delta, v_new_balance, v_entry_sequence, p_kind, trim(p_idempotency_key),
    'GAME_ROUND', p_round_id, p_note, jsonb_build_object('game_slug', p_game_slug)
  ) returning id into v_ledger_id;
  return query select v_ledger_id, v_new_balance, false;
end;
$$;

create or replace function public.resolve_play_point_request(
  p_actor_id uuid,
  p_request_id uuid,
  p_approve boolean,
  p_note text default null,
  p_idempotency_key text default null
)
returns table(status public.request_status, balance_after bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_request public.play_point_requests;
  v_balance bigint := null;
  v_key text;
begin
  perform public.assert_active_admin(p_actor_id);
  select * into v_request from public.play_point_requests where id = p_request_id for update;
  if not found then
    raise exception 'Play-point request not found' using errcode = 'P0001';
  end if;
  if v_request.status <> 'PENDING' then
    raise exception 'Play-point request is already resolved' using errcode = 'P0001';
  end if;

  update public.play_point_requests
  set status = case when p_approve then 'APPROVED' else 'DENIED' end,
      admin_note = p_note,
      reviewed_by = p_actor_id,
      reviewed_at = now()
  where id = p_request_id;

  if p_approve then
    v_key := coalesce(nullif(trim(p_idempotency_key), ''), 'point-request:' || p_request_id::text);
    select a.balance_after into v_balance from public.adjust_play_points(
      p_actor_id, v_request.player_id, v_request.amount, 'REQUEST_ALLOCATION',
      v_key, 'PLAY_POINT_REQUEST', p_request_id::text,
      coalesce(p_note, 'Virtual play-point request approved')
    ) a;
  else
    perform public.audit_admin_action(
      p_actor_id, 'PLAY_POINT_REQUEST_DENIED', 'PLAY_POINT_REQUEST', p_request_id::text,
      null, jsonb_build_object('status', 'DENIED'), p_note
    );
  end if;

  return query select
    case when p_approve then 'APPROVED'::public.request_status else 'DENIED'::public.request_status end,
    v_balance;
end;
$$;

create or replace function public.provision_operator_profile(
  p_primary_id uuid,
  p_auth_user_id uuid,
  p_operator_id text,
  p_auth_email text,
  p_display_name text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  perform public.assert_primary_admin(p_primary_id);
  if trim(p_operator_id) !~ '^[A-Za-z0-9][A-Za-z0-9._]{1,22}[A-Za-z0-9]$' then
    raise exception 'Operator ID must be 3-24 characters: letters, numbers, dots or underscores' using errcode = '22023';
  end if;

  insert into public.profiles(
    id, login_id, auth_email, account_kind, status, display_name, full_name,
    email_verified, accepted_terms, settings, play_points_balance
  ) values (
    p_auth_user_id, trim(p_operator_id), lower(trim(p_auth_email)), 'ADMIN', 'ACTIVE',
    coalesce(nullif(trim(p_display_name), ''), trim(p_operator_id)),
    coalesce(nullif(trim(p_display_name), ''), trim(p_operator_id)),
    true, true,
    '{"sound_enabled":true,"music_enabled":true,"haptics_enabled":true}'::jsonb,
    null
  ) returning * into v_profile;

  insert into public.admin_accounts(user_id, admin_level, created_by)
  values (p_auth_user_id, 'OPERATOR', p_primary_id);
  perform public.audit_admin_action(
    p_primary_id, 'OPERATOR_CREATED', 'ADMIN', p_auth_user_id::text, null,
    jsonb_build_object('operator_id', trim(p_operator_id), 'level', 'OPERATOR')
  );
  return v_profile;
exception when unique_violation then
  raise exception 'That administrator ID is already in use' using errcode = '23505';
end;
$$;

create or replace function public.revoke_operator_profile(
  p_primary_id uuid,
  p_operator_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_operator public.admin_accounts;
begin
  perform public.assert_primary_admin(p_primary_id);
  select * into v_operator from public.admin_accounts
  where user_id = p_operator_id and admin_level = 'OPERATOR' and created_by = p_primary_id
  for update;
  if not found then
    raise exception 'Administrator not found' using errcode = 'P0001';
  end if;

  update public.admin_accounts
  set revoked_at = now(), revoked_by = p_primary_id
  where user_id = p_operator_id and revoked_at is null;
  update public.profiles set status = 'SUSPENDED' where id = p_operator_id;
  perform public.audit_admin_action(
    p_primary_id, 'OPERATOR_REVOKED', 'ADMIN', p_operator_id::text
  );
end;
$$;

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
  if trim(p_login_id) !~ '^GK[0-9]{7}$' then
    raise exception 'Player login ID must be GK followed by seven digits' using errcode = '22023';
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

create or replace function public.set_system_config(
  p_actor_id uuid,
  p_maintenance_mode boolean default null,
  p_maintenance_message text default null,
  p_min_client_version text default null,
  p_welcome_play_points bigint default null
)
returns public.system_config
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_before jsonb;
  v_after public.system_config;
begin
  perform public.assert_active_admin(p_actor_id);
  select to_jsonb(c) into v_before from public.system_config c where key = 'main' for update;
  update public.system_config
  set maintenance_mode = coalesce(p_maintenance_mode, maintenance_mode),
      maintenance_message = coalesce(p_maintenance_message, maintenance_message),
      min_client_version = coalesce(p_min_client_version, min_client_version),
      welcome_play_points = coalesce(p_welcome_play_points, welcome_play_points),
      updated_by = p_actor_id,
      updated_at = now()
  where key = 'main'
  returning * into v_after;
  perform public.audit_admin_action(
    p_actor_id, 'SYSTEM_CONFIG_UPDATED', 'SYSTEM_CONFIG', 'main', v_before, to_jsonb(v_after)
  );
  return v_after;
end;
$$;

-- Bootstrap can run exactly once, after an Auth identity is created.  It is
-- exposed only through a short-lived secret-protected Edge route and is then
-- disabled by removing that function secret.
create or replace function public.bootstrap_primary_admin(
  p_auth_user_id uuid,
  p_login_id text,
  p_auth_email text,
  p_display_name text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  if exists (select 1 from public.admin_accounts) then
    raise exception 'Primary administrator is already configured' using errcode = '42501';
  end if;
  if trim(p_login_id) !~ '^[A-Za-z0-9][A-Za-z0-9._]{1,22}[A-Za-z0-9]$' then
    raise exception 'Administrator ID must be 3-24 characters: letters, numbers, dots or underscores' using errcode = '22023';
  end if;

  insert into public.profiles(
    id, login_id, auth_email, account_kind, status, display_name, full_name,
    email_verified, accepted_terms, play_points_balance
  ) values (
    p_auth_user_id, trim(p_login_id), lower(trim(p_auth_email)), 'ADMIN', 'ACTIVE',
    coalesce(nullif(trim(p_display_name), ''), trim(p_login_id)),
    coalesce(nullif(trim(p_display_name), ''), trim(p_login_id)),
    true, true, null
  ) returning * into v_profile;

  insert into public.admin_accounts(user_id, admin_level) values (p_auth_user_id, 'PRIMARY');
  perform public.audit_admin_action(
    p_auth_user_id, 'PRIMARY_ADMIN_BOOTSTRAPPED', 'ADMIN', p_auth_user_id::text,
    null, jsonb_build_object('login_id', trim(p_login_id), 'level', 'PRIMARY')
  );
  return v_profile;
exception when unique_violation then
  raise exception 'That administrator ID is already in use' using errcode = '23505';
end;
$$;

create or replace function public.prevent_immutable_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end;
$$;

create trigger play_point_ledger_immutable
before update or delete on public.play_point_ledger
for each row execute function public.prevent_immutable_change();

create trigger admin_audit_immutable
before update or delete on public.admin_audit
for each row execute function public.prevent_immutable_change();

insert into public.system_config(key, maintenance_mode, maintenance_message, min_client_version, welcome_play_points)
values ('main', false, 'MyDGP is under scheduled maintenance.', '1.0.0', 1000);

insert into public.compliance_config(key) values ('main');

insert into public.games(slug, name, category, display_order) values
  ('7up7down', '7Up7Down', 'Table', 10),
  ('fun-ab', 'Fun AB', 'Cards', 20),
  ('triple-fun', 'Triple FUN', 'Cards', 30),
  ('fun-roulette', 'Roulette', 'Table', 40),
  ('fun-target', 'Fun Target', 'Arcade', 50),
  ('bingo', 'Bingo', 'Table', 60),
  ('joker-bonus', 'Joker Bonus', 'Slots', 70),
  ('giant-jackpot', 'Giant Jackpot', 'Slots', 80),
  ('golden-wheel', 'Golden Wheel', 'Wheel', 90),
  ('keno', 'Keno', 'Numbers', 100),
  ('checker', 'Checker', 'Wheel', 110),
  ('lucky-8-line', 'Lucky 8 Line', 'Slots', 120),
  ('fever-joker-bonus', 'Fever Joker Bonus', 'Slots', 130),
  ('no-hold', 'No Hold', 'Cards', 140),
  ('champion-poker', 'Champion Poker', 'Cards', 150);

-- Browser roles get no direct table or RPC access. Supabase Edge Functions
-- use the service role server-side and retain the minimum needed access.
revoke all on schema public from public, anon, authenticated;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

alter table public.profiles enable row level security;
alter table public.admin_accounts enable row level security;
alter table public.play_point_ledger enable row level security;
alter table public.play_point_requests enable row level security;
alter table public.signup_requests enable row level security;
alter table public.support_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.games enable row level security;
alter table public.announcements enable row level security;
alter table public.system_config enable row level security;
alter table public.compliance_config enable row level security;
alter table public.player_limits enable row level security;
alter table public.exclusions enable row level security;
alter table public.admin_audit enable row level security;
alter table public.legacy_documents enable row level security;
alter table public.legacy_identity_map enable row level security;
alter table public.migration_runs enable row level security;
