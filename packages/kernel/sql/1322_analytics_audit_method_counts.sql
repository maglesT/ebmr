-- Phase 7 slice 7b-1 (Phase 6A residual P6A7-7; draft control DI-53): the flag counts of the audit-trail methods are
-- read only by ANALYTICS.DI_REVIEW holders.
--
-- Handbook: modules/analytics.md
--
-- Why. The audit-trail methods (ATA.*, 6A-4) raise flags about persons only (restricted, DI-53). The monitor
-- (analytics.method_monitor_v1) and the run list (analytics.run_v1) gave every reader of the views their monthly and
-- per-run counts (flags, the dispositioned share, the false-alarm rate, a run's output and flag counts): no person, rule
-- or entry, but a site-wide count of the hits data-integrity review keeps to itself.
--
--   analytics.method_monitor_v1  replaced (same columns): for an ATA.* method read without ANALYTICS.DI_REVIEW,
--                                flags, dispositioned_share and false_alarm_rate are NULL (restricted); runs and
--                                failures stay (they say whether the method ran, not what it found). Every other
--                                method is unchanged.
--   analytics.run_v1             replaced (same columns): for an ATA.* run read without ANALYTICS.DI_REVIEW, counts
--                                leaves out its outputs and flags (the run, its status, times, inputs and hash stay).
-- Who holds it is asked once per query through analytics.viewer_holds_di_review() (kernel 1281: administrators refused
-- first, then iam.require_permission; any refusal or a read-only transaction answers false, so it fails closed).
-- The audit-trail methods are those named ATA.*, as kernel 1261, 1280 and 1282 name them.

set local role ebmr_owner;

create or replace view analytics.method_monitor_v1 as
  with viewer as materialized (select analytics.viewer_holds_di_review() as di)
  select m.method, m.version, m.month, m.runs, m.failures,
         case when m.method like 'ATA.%' and not (select di from viewer) then null else m.flags end as flags,
         case when m.method like 'ATA.%' and not (select di from viewer) then null else m.dispositioned_share end as dispositioned_share,
         case when m.method like 'ATA.%' and not (select di from viewer) then null else m.false_alarm_rate end as false_alarm_rate
    from analytics.method_monitor_rows_v1() m;

create or replace view analytics.run_v1 as
  with viewer as materialized (select analytics.viewer_holds_di_review() as di)
  select r.id as run_id, r.method, r.version, r.reference_set, r.trigger, r.inputs, r.runtime, r.started_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(r.inputs) x) as data_as_of,
         case when e.status is not null then e.status
              when r.started_at < statement_timestamp() - interval '1 hour' then 'FAILED'
              else 'RUNNING' end as status,
         e.ended_at, e.output_sha256,
         case when r.method like 'ATA.%' and e.counts is not null and not (select di from viewer) then e.counts - 'outputs' - 'flags'
              else e.counts end as counts,
         e.error
    from analytics.run r
    left join analytics.run_end e on e.run = r.id;

reset role;
