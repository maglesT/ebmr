-- Injectables I-1c2 (lead ruling, 10 November 2026; supersedes default D-P6c-6 of slice 6c): the post-use inspection of the
-- packaging line no longer needs a second person before the order completes, in any edition.
--
-- Handbook: modules/tablets-server.md
--
-- The inspection itself stays required: 21 CFR 211.188(b)(6) asks the batch record to document the inspection of the
-- packaging and labelling area before and after use, for every drug product. No binding clause asks for a second person
-- on that after-use inspection: 211.130(e) and EU GMP Ch.5 5.50 are pre-use line clearance; revised Schedule M Part I
-- 17.3.9 and 18.5.2-18.5.3 ask for a recorded pre-use check, and 18.5.11 for the destruction of unused batch-coded
-- material; its Part VIII 7.1 independent check is a pre-use check of oral-solid packaging equipment. A firm-designated
-- significant step needs its checker (211.188(b)(11)), but the inspection is no step. By the owner's rule (a refusal with
-- no binding clause is a defect) the unverified-inspection gap of tablets 1230 is removed.
--
--   tab.packaging_completion_problem(batch)   CREATE OR REPLACE of tablets 1230: the first gap that blocks the order's
--                                 completion: a G-21 step not performed or awaiting its checker's signature, a missing
--                                 specimen, an open line stop, no post-use inspection, or a latest one that did not pass
--                                 (EBMR-LBL-061 through recipe.a2_packaging_completion). tab.verify_post_use_inspection is
--                                 unchanged: optional, still never by the inspector (-043, -044).

create or replace function tab.packaging_completion_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  g    record;
  v_p  text;
  s    tab.line_stop;
  i    tab.post_use_inspection;
begin
  if not exists (select 1 from tab.g21_steps_of(p_batch)) then
    return null;
  end if;
  for g in select * from tab.g21_steps_of(p_batch) loop
    continue when g.inst ->> 'status' in ('NOT_APPLICABLE', 'SKIPPED');
    if g.inst ->> 'status' = 'AWAITING_VERIFICATION' then
      return format('step %s awaits its checker''s signature, which is the check of its specimens (PR-16)', g.step_key);
    end if;
    if g.inst ->> 'status' is distinct from 'COMPLETED' then
      return format('step %s is not performed', g.step_key);
    end if;
    v_p := tab.g21_specimen_problem(p_batch, g.step_key);
    if v_p is not null then
      return v_p;
    end if;
    s := tab.open_line_stop(p_batch, g.step_key);
    if s.id is not null then
      return format('step %s has an open line stop (%s on job %s) that QA has not resolved (PR-36)', g.step_key, s.cause, s.job_id);
    end if;
  end loop;
  -- 211.188(b)(6): the after-use inspection is in the record and the latest one passed. No second person (header).
  select * into i from tab.post_use_inspection p where p.batch_id = p_batch order by p.recorded_at desc, p.id desc limit 1;
  if i.id is null then
    return 'the line has no post-use inspection (PR-34)';
  end if;
  if not i.passed then
    return 'the latest post-use inspection of the line did not pass: clear the line and inspect again (PR-34)';
  end if;
  return null;
end
$$;
