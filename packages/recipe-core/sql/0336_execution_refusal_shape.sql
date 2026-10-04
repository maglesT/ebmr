-- Recipe core, execution store (module C3): a refused row records the engine's refusal as the engine builds it, and an
-- accepted row records none (Phase 2 exit review F12, the round-6 verification, found while closing it: lane round 1 of
-- round 5; DI-05, DI-30, DI-34; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
-- recipe.append_execution (0210, 0295) asks a refused row for a refusal that is an object with a code, and nothing
-- else; the table's check asks a refused row for a refusal at all. 0335 holds a row's command and evidence to what the
-- server records, but not its refusal, and the release gate's replay compares a row's verdict, events and state, never
-- its refusal (recipe-core execution/verify.ts). So, through the application role (apps/tablets-server/test/execution/
-- db-guards-row-shape.test.ts, round 7, the refusal test), a refused row was recorded with the real-format lot number
-- L2409-0017 as a member of its own in its refusal ({code, message, controls, lotNumber}), as its code, as one of its
-- controls, or with its controls as a text; and an accepted row was recorded with a refusal beside it.
--
-- What changed (constraint trigger zz_execution_row_refusal on recipe.execution_command, after insert, not deferred,
-- beside 0335's zz_execution_row_shape; EBMR-EXE-126): recipe.refusal_problem holds the refusal of a row to the
-- engine's Refusal (engine/types.ts {code, message, controls}; tx.ts refuse): an accepted row records none; a refused row
-- records exactly those three members, the code an engine or block rule code (ENG-... or G<nn>-..., as engine/tx.ts and
-- the blocks name them; a test compares the codes in the engine's and the blocks' sources and every refusal of the
-- engine's own runs with it), the message a text, the controls a list of control ids of the register (DI-, IN-, INV-,
-- PR-, ST- and two digits). The message is the engine's own words and quotes what was sent; it is free text in the sense
-- of decision F12.5 (a text in the format of a real identifier can sit there, as in what was sent).
--
-- The new functions are owned by ebmr_owner and private to it; the trigger function is SECURITY DEFINER; both pin their
-- search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- DI-05, DI-30, DI-34 (F12, round-6 verification): why refusal p_refusal is not the engine's refusal of a row with verdict
-- p_accepted (header); NULL when it is.
create function recipe.refusal_problem(p_accepted boolean, p_refusal jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if p_accepted is true then
    return case when p_refusal is not null then 'an accepted row records no refusal' end;
  end if;
  return recipe.command_member_problem(
    '{"t": "object", "of": "the engine''s refusal", "fields": {
       "code": {"t": "text", "pattern": "^(ENG|G[0-9]{2})(-[A-Z0-9]+)+$"},
       "message": {"t": "text"},
       "controls": {"t": "list", "items": {"t": "text", "pattern": "^(DI|IN|INV|PR|ST)-[0-9]{2}$"}}}}'::jsonb,
    p_refusal, 'refusal', false);
end
$$;

-- DI-05, DI-30, DI-34: a row records the engine's refusal as the engine builds it (header). EBMR-EXE-126. Raises; returns
-- nothing.
create function recipe.execution_row_refusal_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text := recipe.refusal_problem(new.accepted, new.refusal);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: %s. A refused row records the engine''s refusal as the engine builds it, {code, message, controls}, and an accepted row none, so nothing sits in the record unread (DI-05, DI-30, DI-34). [EBMR-EXE-126]',
                       case new.kind when 'PREPARE' then 'preparation' when 'SWEEP' then 'sweep' when 'ISSUE' then 'issue' else case when new.accepted then 'accepted' else 'refused' end end,
                       coalesce(new.command_type, new.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create constraint trigger zz_execution_row_refusal after insert on recipe.execution_command
  for each row execute function recipe.execution_row_refusal_check();

revoke all on function recipe.refusal_problem(boolean, jsonb), recipe.execution_row_refusal_check() from public;

reset role;
