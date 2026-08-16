-- Let the transfer-PIN functions resolve pgcrypto.
--
-- Both functions call crypt() and gen_salt() while pinning
-- `search_path = pg_catalog, public, pg_temp`. That is correct hardening for a
-- SECURITY DEFINER function, but pgcrypto is installed into the `extensions`
-- schema on Supabase rather than `public`, so neither symbol resolved and
-- setting a PIN failed in production with:
--   function gen_salt(unknown, integer) does not exist
--
-- Local verification did not catch this: the test harness creates pgcrypto with
-- no schema argument, which lands it in `public`, where the original path finds
-- it. Only the deployed project has it under `extensions`.
--
-- Adding `extensions` to the path keeps both environments working and leaves
-- the rest of the hardening intact: the path stays explicit and still excludes
-- anything user-writable. The function bodies are untouched.

alter function public.set_player_transfer_pin(uuid, text, uuid)
  set search_path = pg_catalog, public, extensions, pg_temp;

alter function public.submit_point_transfer(uuid, text, text, bigint, text, text)
  set search_path = pg_catalog, public, extensions, pg_temp;
