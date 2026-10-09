-- Recipe core, execution store (module C3): a recorded signature keeps its validity; a missing one is a change (Phase 2
-- exit, SQL mutation kill work, defect D8; DI-35, INV-10, PR-14; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- recipe.signature_change_problem (0300) lets a step's recorded signature stay as recorded or be made invalid (valid
-- true to false), and nothing else. Its test compared the validity before and after with `=` inside `not (...)`: when
-- the stored signature had lost its `valid` member, or the recorded one had none, the comparison was NULL, the whole
-- condition NULL, and nothing was refused. Through the application role, an accepted RAISE_EXCEPTION whose state
-- deleted `valid` from operator1's recorded PERFORMED signature of another step was stored 'ok' (the kill agent of the
-- execution-state-binding group, reproduced here by apps/tablets-server/test/mutation/execution-state-binding.test.ts
-- "D8: ..."). The sibling rule for stage sign-offs (recipe.stage_sign_off_problem, 0307) already wrapped the same
-- comparison in coalesce(..., false).
--
-- What changed: recipe.signature_change_problem (CREATE OR REPLACE) reads a validity that is not exactly true before
-- and exactly false after as no permitted invalidation, so a signature whose validity is dropped, or given to one
-- recorded without it, is refused as changed (EBMR-EXE-128 through zb_execution_state_binding, as before). A signature
-- recorded without a validity and kept so is kept, as before. Nothing else in the function changes.
--
-- CREATE OR REPLACE by the same owner keeps the owner, the privileges (none for PUBLIC) and the search_path. Applied as
-- a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- Why the signatures of step instance p_new differ from those of p_old otherwise than the engine changes them; NULL when
-- they do not. A signature the step recorded stays as recorded, except that it is made invalid (valid true -> false)
-- when the data it covered changes; a new signature is appended only with an e-signature the row carries (p_sigs).
-- A validity missing on either side is not true -> false (D8: fail closed).
create or replace function recipe.signature_change_problem(p_old jsonb, p_new jsonb, p_sigs uuid[]) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_old jsonb := case when jsonb_typeof(p_old -> 'signatures') = 'array' then p_old -> 'signatures' else '[]'::jsonb end;
  v_new jsonb := p_new -> 'signatures';
  o     jsonb;
  x     jsonb;
begin
  if jsonb_typeof(v_new) is distinct from 'array' or jsonb_array_length(v_new) < jsonb_array_length(v_old) then
    return 'a signature it recorded is gone';
  end if;
  for i in 0 .. jsonb_array_length(v_old) - 1 loop
    o := v_old -> i;
    x := v_new -> i;
    if jsonb_typeof(o) is distinct from 'object' or jsonb_typeof(x) is distinct from 'object' then
      return 'a signature it records is malformed';
    end if;
    if (x - 'valid') is distinct from (o - 'valid')
       or ((x -> 'valid') is distinct from (o -> 'valid') and not coalesce((o -> 'valid') = 'true'::jsonb and (x -> 'valid') = 'false'::jsonb, false)) then
      return format('signature %s it recorded is changed, or made valid again', coalesce(o ->> 'id', '(no id)'));
    end if;
  end loop;
  for i in jsonb_array_length(v_old) .. jsonb_array_length(v_new) - 1 loop
    x := v_new -> i;
    if not coalesce((x ->> 'id') = any (p_sigs::text[]), false) then
      return format('signature %s is not an e-signature this row carries', coalesce(x ->> 'id', '(no id)'));
    end if;
  end loop;
  return null;
end
$$;

reset role;
