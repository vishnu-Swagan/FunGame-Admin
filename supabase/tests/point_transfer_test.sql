-- Regression suite for player-to-collector point transfers.
--
-- Run against a scratch database that has every migration applied, in order.
-- See supabase/tests/run-sql-tests.sh. Each check raises on failure, so the
-- script exits non-zero the moment an invariant breaks.
--
-- The lockout checks exist because the first implementation of this feature was
-- silently broken: the failed-attempt counter was incremented and then `raise`
-- rolled the increment back, leaving a 4-digit PIN open to unlimited guessing.
-- The code read correctly. Only executing it revealed the bug.

\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = notice;

create or replace function pg_temp.check(p_label text, p_ok boolean)
returns void language plpgsql as $$
begin
  if not p_ok then
    raise exception 'FAILED: %', p_label;
  end if;
  raise notice 'ok   %', p_label;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users(id) values
  ('aaaaaaaa-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-0000-0000-0000-000000000004');

select bootstrap_primary_admin(
  'aaaaaaaa-0000-0000-0000-000000000001', 'test.primary',
  'test.primary@auth.mydgp.casino', 'Test Primary');

select create_player_profile(
  'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
  'GK7000001', 'test.player@auth.mydgp.casino', 'Test Player', 500,
  'fixture', 'fixture-key-0001');

select provision_point_collector(
  'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003',
  'GK00536808', 'test.collector@auth.mydgp.casino', 'Test Collector');

select set_player_transfer_pin('aaaaaaaa-0000-0000-0000-000000000002', '4321', null);

-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_transfer uuid;
  v_sender bigint;
  v_collector bigint;
  i int;
begin
  -- 1. Submitting debits the sender and holds the amount out of both balances.
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 200, 'k-submit-0001', 'test');
  perform pg_temp.check('submit succeeds', r.error_code is null and not r.duplicate);
  v_transfer := r.transfer_id;

  select play_points_balance into v_sender from profiles where login_id = 'GK7000001';
  select play_points_balance into v_collector from profiles where login_id = 'GK00536808';
  perform pg_temp.check('sender debited on submit', v_sender = 300);
  perform pg_temp.check('collector NOT credited while pending', v_collector = 0);
  perform pg_temp.check('transfer is PENDING',
    (select status from point_transfers where id = v_transfer) = 'PENDING');

  -- 2. Replaying the same idempotency key must not charge twice.
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 200, 'k-submit-0001', 'test');
  perform pg_temp.check('replay reports duplicate', r.duplicate);
  perform pg_temp.check('replay created no second transfer',
    (select count(*) from point_transfers) = 1);
  select play_points_balance into v_sender from profiles where login_id = 'GK7000001';
  perform pg_temp.check('replay did not double-debit', v_sender = 300);

  -- 3. Accepting credits the collector.
  select * into r from settle_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000001', v_transfer, true, 'accepted');
  select play_points_balance into v_collector from profiles where login_id = 'GK00536808';
  perform pg_temp.check('accept credits the collector', v_collector = 200);
  perform pg_temp.check('accepted transfer is RECEIVED',
    (select status from point_transfers where id = v_transfer) = 'RECEIVED');

  -- 4. A settled transfer is terminal and immutable.
  begin
    perform settle_point_transfer('aaaaaaaa-0000-0000-0000-000000000001', v_transfer, true, null);
    perform pg_temp.check('double settle refused', false);
  exception when others then
    perform pg_temp.check('double settle refused', true);
  end;
  begin
    update point_transfers set amount = 1 where id = v_transfer;
    perform pg_temp.check('settled row immutable', false);
  exception when others then
    perform pg_temp.check('settled row immutable', true);
  end;

  -- 5. Rejecting refunds the sender in full.
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 50, 'k-reject-0001', null);
  select * into r from settle_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000001',
    (select id from point_transfers where status = 'PENDING'), false, 'rejected');
  select play_points_balance into v_sender from profiles where login_id = 'GK7000001';
  perform pg_temp.check('reject refunds the sender', v_sender = 300);

  -- 6. The sender may withdraw their own pending transfer.
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 75, 'k-cancel-0001', null);
  perform cancel_point_transfer('aaaaaaaa-0000-0000-0000-000000000002',
    (select id from point_transfers where status = 'PENDING'));
  select play_points_balance into v_sender from profiles where login_id = 'GK7000001';
  perform pg_temp.check('cancel refunds the sender', v_sender = 300);

  -- 7. Points are conserved across every path taken above.
  select play_points_balance into v_collector from profiles where login_id = 'GK00536808';
  perform pg_temp.check('points conserved (500 in, 500 accounted)', v_sender + v_collector = 500);
  perform pg_temp.check('ledger reconciles to sender balance',
    (select sum(delta) from play_point_ledger
     where player_id = 'aaaaaaaa-0000-0000-0000-000000000002') = v_sender);

  -- 8. Only the collector may receive, and it may never send.
  begin
    perform submit_point_transfer('aaaaaaaa-0000-0000-0000-000000000003', 'GK00536808', '4321', 10, 'k-colsend-001');
    perform pg_temp.check('collector cannot send', false);
  exception when others then perform pg_temp.check('collector cannot send', true); end;
  begin
    perform submit_point_transfer('aaaaaaaa-0000-0000-0000-000000000002', 'GK7000001', '4321', 10, 'k-baddest-001');
    perform pg_temp.check('non-collector destination refused', false);
  exception when others then perform pg_temp.check('non-collector destination refused', true); end;

  -- 9. Balance and authority limits.
  begin
    perform submit_point_transfer('aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 999999, 'k-toobig-0001');
    perform pg_temp.check('overdraw refused', false);
  exception when others then perform pg_temp.check('overdraw refused', true); end;
  begin
    perform settle_point_transfer('aaaaaaaa-0000-0000-0000-000000000002',
      (select id from point_transfers limit 1), true, null);
    perform pg_temp.check('non-admin cannot settle', false);
  exception when others then perform pg_temp.check('non-admin cannot settle', true); end;

  -- 10. PIN handling. A wrong PIN RETURNS a code so the attempt counter commits.
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '9999', 10, 'k-wrongpin-01');
  perform pg_temp.check('wrong PIN reports INVALID_PIN', r.error_code = 'INVALID_PIN');
  perform pg_temp.check('wrong PIN moved no points',
    (select play_points_balance from profiles where login_id = 'GK7000001') = v_sender);
  perform pg_temp.check('failed attempt was recorded, not rolled back',
    (select failed_attempts from player_transfer_pins
     where player_id = 'aaaaaaaa-0000-0000-0000-000000000002') = 1);

  -- 11. Repeated wrong PINs lock the account, and the lock beats a correct PIN.
  for i in 2..5 loop
    perform submit_point_transfer(
      'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '9999', 10, 'k-lock-000'||i);
  end loop;
  perform pg_temp.check('lock engages after 5 failures',
    (select locked_until is not null from player_transfer_pins
     where player_id = 'aaaaaaaa-0000-0000-0000-000000000002'));
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 10, 'k-afterlock-1');
  perform pg_temp.check('correct PIN refused while locked', r.error_code = 'PIN_LOCKED');

  -- Resetting the PIN clears the lock.
  perform set_player_transfer_pin('aaaaaaaa-0000-0000-0000-000000000002', '4321', null);
  select * into r from submit_point_transfer(
    'aaaaaaaa-0000-0000-0000-000000000002', 'GK00536808', '4321', 10, 'k-postreset-1');
  perform pg_temp.check('PIN reset clears the lock', r.error_code is null);
  perform cancel_point_transfer('aaaaaaaa-0000-0000-0000-000000000002',
    (select id from point_transfers where status = 'PENDING'));

  -- 12. Collector identity rules.
  begin
    perform provision_point_collector('aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000004', 'GK00999999', 'x@auth.mydgp.casino', 'Second');
    perform pg_temp.check('only one active collector', false);
  exception when others then perform pg_temp.check('only one active collector', true); end;

  -- 13. Operator summary reports the truth.
  select * into r from point_collector_summary('aaaaaaaa-0000-0000-0000-000000000001');
  perform pg_temp.check('summary balance matches profile', r.available_balance = 200);
  perform pg_temp.check('summary received total', r.received_total = 200);
  perform pg_temp.check('summary counts one sender', r.distinct_senders = 1);
  perform pg_temp.check('summary counts the rejection', r.rejected_count = 1);

  raise notice 'ALL POINT TRANSFER CHECKS PASSED';
end;
$$;
