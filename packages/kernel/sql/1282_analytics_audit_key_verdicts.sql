-- Phase 6A exit (slice 6A-7, lead item P6A5-2): QA's verdicts on the audit-trail flag keys as an input of the analytics
-- role, so a FALSE_ALARM lowers the review priority's audit-trail term (ADR 0020 points 3 and 4; draft controls DI-51,
-- DI-52, DI-53; D-6A-5-4, D-6A-7-R4).
--
-- Handbook: modules/analytics.md
--
-- Why. REVIEW.PRIORITY counts the audit-trail rule hits on a record's entries by running the rules again over its own
-- snapshot (D-6A-5-4), because the analytics role read only catalogued report views and no report view may read the
-- analytics schema (the DI-51 dependency proof). A disposition therefore did not lower the term: a hit QA had found to
-- be a false alarm kept raising the record's priority. The verdicts live in the analytics schema, so the input is a view
-- there; nothing outside the schema depends on it, and the DI-51 dependency proof is unchanged.
--
--   analytics.audit_key_verdict_v1   one row per audit-trail key (kernel 1261, analytics.flag_key) that has a current
--                                    disposition: the key, its current verdict (the group's current one, kernel 1280)
--                                    and when it was recorded. The key is spelled here with the operators flag_key uses
--                                    (no function call), so the analytics role needs no right beyond SELECT on the view;
--                                    a test keeps the two spellings equal. No cause, person or deviation reference is in
--                                    it. SELECT to ebmr_analytics only: it names persons (DI-53), so it is not in the report
--                                    catalogue and neither the application nor the reporting role reads it.
--   analytics.input_registry         its name check now admits an input of the analytics schema (analytics.<name>_v<n>);
--                                    the view is registered as version 1, slice 6A-7. The segregation check
--                                    (analytics.role_problems) already admits SELECT on a catalogued view by its name.
-- Nothing here writes GMP data.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1282_analytics_audit_key_verdicts)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the verdicts of the audit-trail flag keys as an analytics input (P6A5-2; DI-51, DI-52, DI-53)'));

create view analytics.audit_key_verdict_v1 as
  with keyed as (
    select f.id,
           r.method || '|' || f.rule || '|' || f.subject_kind || '|' || f.subject_ref || '|'
           || coalesce(f.reasons -> 0 -> 'evidence' -> 0 ->> 'kind', '') || ':' || coalesce(f.reasons -> 0 -> 'evidence' -> 0 ->> 'ref', '') as flag_key
      from analytics.flag f
      join analytics.run r on r.id = f.run
      join analytics.run_end e on e.run = f.run and e.status = 'DONE'
     where f.restricted and r.method like 'ATA.%')
  select distinct on (k.flag_key) k.flag_key, d.verdict, d.recorded_at as dispositioned_at
    from keyed k
    join analytics.flag_disposition d on d.flag = k.id
   where not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id)
   order by k.flag_key, d.recorded_at desc, d.id desc;
revoke all on analytics.audit_key_verdict_v1 from public;
grant select on analytics.audit_key_verdict_v1 to ebmr_analytics;

alter table analytics.input_registry drop constraint input_registry_name_check;
alter table analytics.input_registry add constraint input_registry_name_check
  check (name ~ '^report\.[a-z][a-z0-9_]*_v[1-9][0-9]*(\(.*\))?$' or name ~ '^analytics\.[a-z][a-z0-9_]*_v[1-9][0-9]*$');

insert into analytics.input_registry (name, kind, version, owner_slice, grain, description)
values ('analytics.audit_key_verdict_v1', 'VIEW', 1, '6A-7', 'audit-trail flag key with a current disposition',
        'QA''s current verdict on each audit-trail flag key (kernel 1261 key): REVIEW.PRIORITY leaves out a hit QA found to be a false alarm (P6A5-2)');

select kernel.set_actor_context(null);

reset role;
