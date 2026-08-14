-- A Mongo snapshot is only meaningful when one archive/materialization run is
-- in flight.  The importer advances a run through STARTED -> ARCHIVED ->
-- MATERIALIZED -> VALIDATED; a failure is explicitly marked FAILED and may be
-- restarted after review.  This partial unique index is deliberately narrow:
-- completed or failed audit records remain available indefinitely.
create unique index migration_runs_one_incomplete_source
  on public.migration_runs (source_name)
  where status in ('STARTED', 'ARCHIVED', 'MATERIALIZED');
