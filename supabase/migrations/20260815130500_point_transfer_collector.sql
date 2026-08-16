-- Player-to-collector virtual point transfers with two-sided settlement.
--
-- Shape mirrors the reference cabinet: the sender is debited when they submit,
-- the amount sits PENDING, and it only reaches the destination when the
-- receiving side accepts. A rejection or a sender cancellation refunds in full.
-- Every movement is an immutable ledger entry; no balance is ever written
-- directly, and the pending amount is held out of both balances in between.
--
-- This deployment allows exactly one destination: a single admin-owned
-- collector account. There is deliberately no player-to-player path, so points
-- can only ever flow inward to an account the operator controls.
--
-- Virtual play points only. No cash, deposit, payout or settlement semantics.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'transfer_status') then
    create type public.transfer_status as enum (
      'PENDING', 'RECEIVED', 'REJECTED', 'CANCELLED'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared ledger core
-- ---------------------------------------------------------------------------

-- `adjust_play_points` asserts an active administrator before writing, which is
-- correct for operator adjustments but wrong for a player moving their own
-- points. Rather than reimplement the ledger invariants (row lock, idempotency
-- replay, entry sequencing, non-negative balance) a second time and risk the
-- two copies drifting, the core is extracted here and both callers share it.
-- `adjust_play_points` keeps its exact previous behaviour.
create or replace function public.apply_play_point_entry(
  p_actor_id uuid,
  p_player_id uuid,
  p_delta bigint,
  p_kind public.play_point_kind,
  p_idempotency_key text,
  p_reference_type text default null,
  p_reference_id text default null,
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_audit boolean default true
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
  if p_delta = 0 then
    raise exception 'Play-point adjustment cannot be zero' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;

  -- Locking the player first serializes both balance changes and duplicate
  -- retries, so an interrupted request can never issue twice.
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

  if p_audit then
    perform public.audit_admin_action(
      p_actor_id, 'PLAY_POINTS_ADJUSTED', 'PLAYER', p_player_id::text, null,
      jsonb_build_object('delta', p_delta, 'balance_after', v_new_balance, 'kind', p_kind), p_note
    );
  end if;
  return query select v_ledger_id, v_new_balance, false;
end;
$$;

-- Unchanged contract: assert the operator, then apply the shared core.
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
begin
  perform public.assert_active_admin(p_actor_id);
  return query select * from public.apply_play_point_entry(
    p_actor_id, p_player_id, p_delta, p_kind, p_idempotency_key,
    p_reference_type, p_reference_id, p_note, p_metadata, true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Collector account
-- ---------------------------------------------------------------------------

-- The collector is a PLAYER-kind profile so that it carries a real ledger and
-- the balance triggers apply unchanged. It is registered here to mark it as
-- operator-owned: it may receive, it may never send, and it may never be signed
-- into from the player client.
create table if not exists public.point_collector_accounts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete restrict,
  label text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by uuid references public.profiles(id) on delete restrict,
  check (active or retired_at is not null)
);

-- At most one collector may be active, so "the collector ID" is never ambiguous.
-- Every active row carries the same `active = true`, so a unique index over that
-- column restricted to active rows admits exactly one.
create unique index if not exists point_collector_single_active_idx
  on public.point_collector_accounts (active) where active;

create or replace function public.is_point_collector(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.point_collector_accounts
    where profile_id = p_profile_id and active
  );
$$;

-- ---------------------------------------------------------------------------
-- Transfer PIN
-- ---------------------------------------------------------------------------

create table if not exists public.player_transfer_pins (
  player_id uuid primary key references public.profiles(id) on delete restrict,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  set_at timestamptz not null default now(),
  set_by uuid references public.profiles(id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

create table if not exists public.point_transfers (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique,
  from_player_id uuid not null references public.profiles(id) on delete restrict,
  to_profile_id uuid not null references public.profiles(id) on delete restrict,
  amount bigint not null check (amount > 0),
  status public.transfer_status not null default 'PENDING',
  debit_ledger_id uuid not null references public.play_point_ledger(id) on delete restrict,
  credit_ledger_id uuid references public.play_point_ledger(id) on delete restrict,
  refund_ledger_id uuid references public.play_point_ledger(id) on delete restrict,
  idempotency_key text not null,
  note text,
  settled_by uuid references public.profiles(id) on delete restrict,
  settled_at timestamptz,
  settle_note text,
  created_at timestamptz not null default now(),
  unique (from_player_id, idempotency_key),
  -- A terminal transfer must carry exactly the ledger entry that closed it.
  check (
    (status = 'PENDING'   and credit_ledger_id is null and refund_ledger_id is null and settled_at is null)
    or (status = 'RECEIVED'  and credit_ledger_id is not null and refund_ledger_id is null and settled_at is not null)
    or (status in ('REJECTED', 'CANCELLED') and refund_ledger_id is not null and credit_ledger_id is null and settled_at is not null)
  )
);

create index if not exists point_transfers_pending_idx
  on public.point_transfers(created_at desc, id) where status = 'PENDING';
create index if not exists point_transfers_from_player_idx
  on public.point_transfers(from_player_id, created_at desc);
create index if not exists point_transfers_destination_idx
  on public.point_transfers(to_profile_id, status, created_at desc);

-- A settled transfer is history. Only the settlement fields may ever be written,
-- and only once, on a row that is still PENDING.
create or replace function public.prevent_point_transfer_rewrite()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.status <> 'PENDING' then
    raise exception 'A settled point transfer is immutable' using errcode = '55000';
  end if;
  if new.id is distinct from old.id
     or new.reference_code is distinct from old.reference_code
     or new.from_player_id is distinct from old.from_player_id
     or new.to_profile_id is distinct from old.to_profile_id
     or new.amount is distinct from old.amount
     or new.debit_ledger_id is distinct from old.debit_ledger_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'Point transfer identity is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists point_transfers_settle_once on public.point_transfers;
create trigger point_transfers_settle_once
  before update on public.point_transfers
  for each row execute function public.prevent_point_transfer_rewrite();

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

create or replace function public.provision_point_collector(
  p_actor_id uuid,
  p_auth_user_id uuid,
  p_login_id text,
  p_auth_email text,
  p_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_login text := upper(trim(p_login_id));
begin
  perform public.assert_active_admin(p_actor_id);
  -- Eight digits, so a collector ID can never collide with an auto-generated
  -- seven-digit player ID.
  if v_login !~ '^GK[0-9]{8}$' then
    raise exception 'A collector ID must be GK followed by eight digits' using errcode = '22023';
  end if;
  if exists (select 1 from public.point_collector_accounts where active) then
    raise exception 'An active collector account already exists' using errcode = '23505';
  end if;

  insert into public.profiles(
    id, login_id, auth_email, account_kind, status, display_name, full_name, play_points_balance
  ) values (
    p_auth_user_id, v_login, lower(trim(p_auth_email)), 'PLAYER', 'ACTIVE',
    coalesce(p_label, 'Point Collector'), coalesce(p_label, 'Point Collector'), 0
  );

  insert into public.point_collector_accounts(profile_id, label, created_by)
  values (p_auth_user_id, p_label, p_actor_id);

  perform public.audit_admin_action(
    p_actor_id, 'POINT_COLLECTOR_PROVISIONED', 'PLAYER', p_auth_user_id::text, null,
    jsonb_build_object('login_id', v_login, 'label', p_label), null
  );
  return p_auth_user_id;
end;
$$;

create or replace function public.set_player_transfer_pin(
  p_player_id uuid,
  p_pin text,
  p_set_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'A transfer PIN must be 4 to 8 digits' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_player_id and account_kind = 'PLAYER' and status = 'ACTIVE'
  ) then
    raise exception 'Player not found' using errcode = 'P0001';
  end if;
  if public.is_point_collector(p_player_id) then
    raise exception 'The collector account cannot hold a transfer PIN' using errcode = '22023';
  end if;

  insert into public.player_transfer_pins(player_id, pin_hash, set_by, failed_attempts, locked_until, set_at)
  values (p_player_id, crypt(p_pin, gen_salt('bf', 10)), p_set_by, 0, null, now())
  on conflict (player_id) do update
    set pin_hash = excluded.pin_hash,
        set_by = excluded.set_by,
        failed_attempts = 0,
        locked_until = null,
        set_at = now();
end;
$$;

-- Submit a transfer: debit the sender now, hold the amount PENDING.
--
-- PIN failures RETURN an error_code rather than raising. This is deliberate and
-- load-bearing: `raise` aborts the transaction, which would roll back the
-- failed-attempt increment along with it, leaving the lockout counter
-- permanently at zero and the PIN open to unlimited guessing. Returning lets
-- the counter commit. Every other failure still raises, because those must roll
-- back. Callers must treat a non-null error_code as a failed transfer.
--
-- Dropped first because `create or replace` cannot widen a function's return
-- type, which would make this migration fail on re-apply.
drop function if exists public.submit_point_transfer(uuid, text, text, bigint, text, text);
create or replace function public.submit_point_transfer(
  p_player_id uuid,
  p_to_login_id text,
  p_pin text,
  p_amount bigint,
  p_idempotency_key text,
  p_note text default null
)
returns table(transfer_id uuid, reference_code text, balance_after bigint, duplicate boolean, error_code text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_pin public.player_transfer_pins;
  v_collector public.profiles;
  v_existing public.point_transfers;
  v_debit_id uuid;
  v_balance bigint;
  v_ref text;
  v_transfer_id uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'Transfer amount must be between 1 and 1000000 points' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;

  -- Replay before any mutation, so a lost response never charges twice.
  select * into v_existing from public.point_transfers
  where from_player_id = p_player_id and idempotency_key = trim(p_idempotency_key);
  if found then
    if v_existing.amount <> p_amount then
      raise exception 'Idempotency key was already used for a different transfer' using errcode = '22023';
    end if;
    select play_points_balance into v_balance from public.profiles where id = p_player_id;
    return query select v_existing.id, v_existing.reference_code, v_balance, true, null::text;
    return;
  end if;

  if public.is_point_collector(p_player_id) then
    raise exception 'The collector account cannot send points' using errcode = '22023';
  end if;

  select c.* into v_collector
  from public.point_collector_accounts a
  join public.profiles c on c.id = a.profile_id
  where a.active and c.login_id = upper(trim(p_to_login_id));
  if not found then
    raise exception 'That destination account does not accept transfers' using errcode = 'P0001';
  end if;

  select * into v_pin from public.player_transfer_pins
  where player_id = p_player_id for update;
  if not found then
    return query select null::uuid, null::text, null::bigint, false, 'PIN_NOT_SET'::text;
    return;
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return query select null::uuid, null::text, null::bigint, false, 'PIN_LOCKED'::text;
    return;
  end if;
  if v_pin.pin_hash <> crypt(coalesce(p_pin, ''), v_pin.pin_hash) then
    -- Committed, not raised. See the note on this function's contract.
    update public.player_transfer_pins
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
    where player_id = p_player_id;
    return query select null::uuid, null::text, null::bigint, false, 'INVALID_PIN'::text;
    return;
  end if;
  if v_pin.failed_attempts <> 0 or v_pin.locked_until is not null then
    update public.player_transfer_pins
    set failed_attempts = 0, locked_until = null
    where player_id = p_player_id;
  end if;

  v_ref := 'PT-' || upper(encode(gen_random_bytes(5), 'hex'));

  -- The sender is the actor on their own debit, and this is not an operator
  -- action, so it must not enter the admin audit trail.
  select e.ledger_id, e.balance_after into v_debit_id, v_balance
  from public.apply_play_point_entry(
    p_player_id, p_player_id, -p_amount, 'TRANSFER_OUT',
    'transfer-out:' || trim(p_idempotency_key),
    'POINT_TRANSFER', v_ref, p_note, jsonb_build_object('to_login_id', v_collector.login_id), false
  ) e;

  insert into public.point_transfers(
    reference_code, from_player_id, to_profile_id, amount, status,
    debit_ledger_id, idempotency_key, note
  ) values (
    v_ref, p_player_id, v_collector.id, p_amount, 'PENDING',
    v_debit_id, trim(p_idempotency_key), p_note
  ) returning id into v_transfer_id;

  return query select v_transfer_id, v_ref, v_balance, false, null::text;
end;
$$;

-- Accept or reject a pending transfer. Accepting credits the collector;
-- rejecting refunds the sender in full. Both are exactly-once by construction:
-- the row lock plus the PENDING guard admit only one settlement.
create or replace function public.settle_point_transfer(
  p_actor_id uuid,
  p_transfer_id uuid,
  p_accept boolean,
  p_note text default null
)
returns table(status public.transfer_status, ledger_id uuid, balance_after bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_transfer public.point_transfers;
  v_ledger_id uuid;
  v_balance bigint;
begin
  perform public.assert_active_admin(p_actor_id);

  select * into v_transfer from public.point_transfers
  where id = p_transfer_id for update;
  if not found then
    raise exception 'Transfer not found' using errcode = 'P0001';
  end if;
  if v_transfer.status <> 'PENDING' then
    raise exception 'That transfer was already settled' using errcode = '22023';
  end if;

  if p_accept then
    select e.ledger_id, e.balance_after into v_ledger_id, v_balance
    from public.apply_play_point_entry(
      p_actor_id, v_transfer.to_profile_id, v_transfer.amount, 'TRANSFER_IN',
      'transfer-in:' || v_transfer.id::text,
      'POINT_TRANSFER', v_transfer.reference_code, p_note,
      jsonb_build_object('transfer_id', v_transfer.id, 'from_player_id', v_transfer.from_player_id), false
    ) e;
    update public.point_transfers
    set status = 'RECEIVED', credit_ledger_id = v_ledger_id,
        settled_by = p_actor_id, settled_at = now(), settle_note = p_note
    where id = p_transfer_id;
  else
    select e.ledger_id, e.balance_after into v_ledger_id, v_balance
    from public.apply_play_point_entry(
      p_actor_id, v_transfer.from_player_id, v_transfer.amount, 'TRANSFER_REFUND',
      'transfer-refund:' || v_transfer.id::text,
      'POINT_TRANSFER', v_transfer.reference_code, p_note,
      jsonb_build_object('transfer_id', v_transfer.id, 'rejected', true), false
    ) e;
    update public.point_transfers
    set status = 'REJECTED', refund_ledger_id = v_ledger_id,
        settled_by = p_actor_id, settled_at = now(), settle_note = p_note
    where id = p_transfer_id;
  end if;

  perform public.audit_admin_action(
    p_actor_id,
    case when p_accept then 'POINT_TRANSFER_RECEIVED' else 'POINT_TRANSFER_REJECTED' end,
    'POINT_TRANSFER', p_transfer_id::text, null,
    jsonb_build_object('amount', v_transfer.amount, 'reference_code', v_transfer.reference_code), p_note
  );

  return query select
    (case when p_accept then 'RECEIVED' else 'REJECTED' end)::public.transfer_status,
    v_ledger_id, v_balance;
end;
$$;

-- The sender withdrawing their own still-pending transfer.
create or replace function public.cancel_point_transfer(
  p_player_id uuid,
  p_transfer_id uuid
)
returns table(status public.transfer_status, ledger_id uuid, balance_after bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_transfer public.point_transfers;
  v_ledger_id uuid;
  v_balance bigint;
begin
  select * into v_transfer from public.point_transfers
  where id = p_transfer_id for update;
  if not found or v_transfer.from_player_id <> p_player_id then
    raise exception 'Transfer not found' using errcode = 'P0001';
  end if;
  if v_transfer.status <> 'PENDING' then
    raise exception 'That transfer was already settled' using errcode = '22023';
  end if;

  select e.ledger_id, e.balance_after into v_ledger_id, v_balance
  from public.apply_play_point_entry(
    p_player_id, p_player_id, v_transfer.amount, 'TRANSFER_REFUND',
    'transfer-cancel:' || v_transfer.id::text,
    'POINT_TRANSFER', v_transfer.reference_code, null,
    jsonb_build_object('transfer_id', v_transfer.id, 'cancelled', true), false
  ) e;

  update public.point_transfers
  set status = 'CANCELLED', refund_ledger_id = v_ledger_id,
      settled_by = p_player_id, settled_at = now()
  where id = p_transfer_id;

  return query select 'CANCELLED'::public.transfer_status, v_ledger_id, v_balance;
end;
$$;

-- Operator view of the collector: identity, live balance, and lifetime totals.
create or replace function public.point_collector_summary(p_actor_id uuid)
returns table(
  profile_id uuid,
  login_id text,
  label text,
  available_balance bigint,
  received_total bigint,
  received_count bigint,
  pending_total bigint,
  pending_count bigint,
  rejected_count bigint,
  distinct_senders bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.assert_active_admin(p_actor_id);
  return query
  select
    c.id,
    c.login_id::text,
    a.label,
    c.play_points_balance,
    coalesce(sum(t.amount) filter (where t.status = 'RECEIVED'), 0)::bigint,
    count(t.id) filter (where t.status = 'RECEIVED')::bigint,
    coalesce(sum(t.amount) filter (where t.status = 'PENDING'), 0)::bigint,
    count(t.id) filter (where t.status = 'PENDING')::bigint,
    count(t.id) filter (where t.status = 'REJECTED')::bigint,
    count(distinct t.from_player_id) filter (where t.status = 'RECEIVED')::bigint
  from public.point_collector_accounts a
  join public.profiles c on c.id = a.profile_id
  left join public.point_transfers t on t.to_profile_id = c.id
  where a.active
  group by c.id, c.login_id, a.label, c.play_points_balance;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: service_role only. No anon or authenticated grant anywhere.
-- ---------------------------------------------------------------------------

revoke all on function public.apply_play_point_entry(uuid, uuid, bigint, public.play_point_kind, text, text, text, text, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.is_point_collector(uuid) from public, anon, authenticated;
revoke all on function public.prevent_point_transfer_rewrite() from public, anon, authenticated, service_role;
revoke all on function public.provision_point_collector(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.set_player_transfer_pin(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.submit_point_transfer(uuid, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.settle_point_transfer(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.cancel_point_transfer(uuid, uuid) from public, anon, authenticated;
revoke all on function public.point_collector_summary(uuid) from public, anon, authenticated;

grant execute on function public.is_point_collector(uuid) to service_role;
grant execute on function public.provision_point_collector(uuid, uuid, text, text, text) to service_role;
grant execute on function public.set_player_transfer_pin(uuid, text, uuid) to service_role;
grant execute on function public.submit_point_transfer(uuid, text, text, bigint, text, text) to service_role;
grant execute on function public.settle_point_transfer(uuid, uuid, boolean, text) to service_role;
grant execute on function public.cancel_point_transfer(uuid, uuid) to service_role;
grant execute on function public.point_collector_summary(uuid) to service_role;

-- `apply_play_point_entry` skips the operator assertion by design, so it is
-- reachable only from the definer-rights functions above. Nothing may call it
-- directly, service_role included.

alter table public.point_collector_accounts enable row level security;
alter table public.player_transfer_pins enable row level security;
alter table public.point_transfers enable row level security;
-- No policies: with RLS on and none defined, only definer-rights functions and
-- the service role reach these tables. The PIN hashes in particular must never
-- be selectable by a signed-in client.
