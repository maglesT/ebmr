-- Sandbox, training and simulation store (module A4), part 5: the identifier rule read in free text, and the kernel's
-- stub tables under it (Phase 2 exit follow-up F12.KERNEL and the class F12 closes; control DI-05, invariant INV-18;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong.
--   * 0810's rule (sandbox.identifier_problem_for, sandbox.guard_identifier) reads a column that holds one identifier.
--     A text that holds an identifier among other words (a comment, a reason, a member of a JSON value) was read by
--     nothing, so each module listed the members it knew to be identifiers, and nine review rounds of F12 each found a
--     member of a test run's record that no list named and that held the real-format lot number L2409-0017.
--   * The kernel's stub tables, which the application role writes directly (0310, 0250, 0530, 0551), carried no sandbox
--     guard: market.stub_batch.batch_number, market.stub_material_lot.code and market.stub_pack.code took any text in
--     a sandbox, and a TEST- one in a GMP installation; their free text (predicates, a stub MBR limit's value, a stub
--     signable's title, value and unit, a sample record's title and body, a step entry's late reason and unit) took a
--     real-format identifier in a sandbox (decision F12.7 reported this to the lead).
--
-- What changed.
--   1. The rule read in text, built on 0810's rule and its pattern table (no second definition of what an identifier
--      looks like):
--      * sandbox.identifier_words(text) and sandbox.identifier_words(jsonb): the words that could name an identifier: the
--        runs of the characters the batch- and lot-number patterns allow (ASCII letters and digits, '/', '.', '-') in the
--        NFKC form of a text with its percent and backslash escapes read (%4C and \u004C are L; the engine's codec
--        writes U+0000 as %00), trimmed of separators at either end, that hold a letter and a digit, other than an
--        ordinal number (1st, 2nd, 11th) and a UUID; of a JSON value, those of every string and every member name at any
--        depth;
--      * sandbox.real_identifier_parts(word): what of a word 0810's rule reads as a real batch or lot number in a
--        sandbox: the word itself when the rule accepts it with the reserved prefix (it has the form of one) and refuses
--        it as it stands (it is not a test one); for a word too long to be one, every run of its parts between separators
--        that is (so L2409-0017 glued to a longer word is still found);
--      * sandbox.real_identifiers(text) and sandbox.real_identifiers(jsonb): the parts so read in a text or a value.
--      What the reading cannot see, stated so it is not over-read: an identifier of digits and separators only
--      (2409-0017: it cannot be told from a number, a range or a date by its form), one broken by spaces or written in
--      words (L 2409 0017, "lot L twenty-four ..."), one in digits other than ASCII after NFKC, and a word with a letter
--      and a digit that is not an identifier (QA1, F12, LBL-1, 5mg) is read as one: the reading is the strict side.
--   2. sandbox.guard_free_text(column [, column ...]): a row trigger function that, in an installation that is not GMP
--      (a sandbox, or a database whose marker cannot be read), refuses a row whose named text, text[] or jsonb columns
--      hold a word read as a real batch or lot number (EBMR-SBX-024). A GMP installation keeps what was written. The
--      refusal names the column, not the word, so a log or a stored answer that records the refusal does not copy it.
--   3. On the kernel's stub tables:
--      * sandbox.guard_identifier (0810) on market.stub_batch.batch_number (BATCH_NUMBER), market.stub_material_lot.code
--        and market.stub_pack.code (LOT_NUMBER: a pack is a unit of a batch's output): in a sandbox TEST- only
--        (EBMR-SBX-022), in a GMP installation never TEST- (EBMR-SBX-021); a GMP installation keeps its real ones;
--      * sandbox.guard_free_text on the free text the application role writes: market.stub_site.predicates,
--        market.stub_product.predicates, market.stub_mbr_limit.value and .predicates, esig.stub_signable.title, .value
--        and .unit, platform.stub_record.title and .body, platform.stub_step_entry.late_reason_text and .unit.
--      The other text columns of these tables are codes of master data (a site, product, line, room, equipment or MBR
--      code; a stub signable's site, area and product scope; a rule key; a late-reason code from the kernel's list) or
--      enumerations, like an MBR's own ids (decision F12.2), not free text.
--
-- The rows already stored keep their values (the triggers read new rows and changed columns). New functions are owned by
-- ebmr_owner; the trigger functions are SECURITY DEFINER; every function pins its search_path with pg_temp last; the
-- reading functions are granted to the application role, as 0810's are. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05: text p_text with its escapes read, in one pass: a percent escape (%XX, two hexadecimal digits; the engine's
-- codec writes U+0000 as %00 and % as %25, recipe-core engine/codec.ts) and a backslash escape (\uXXXX, four) become the
-- character they stand for, U+0000 and a surrogate a space; then the NFKC form. So an identifier written with escapes
-- (%4C2409-0017, \u004C2409-0017) is read as written out, and an escape is not read as a word (\u0000 is no identifier).
create function sandbox.escapes_decoded(p_text text) returns text
language plpgsql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $$
declare
  v_out text := '';
  m     text[];
  v_c   integer;
begin
  if p_text !~ '%[0-9A-Fa-f]{2}|\\[uU][0-9A-Fa-f]{4}' then
    return p_text;
  end if;
  for m in select regexp_matches(p_text, '%([0-9A-Fa-f]{2})|\\[uU]([0-9A-Fa-f]{4})|([^%\\]+|[%\\])', 'g') loop
    if m[3] is not null then
      v_out := v_out || m[3];
    else
      v_c := ('x' || lpad(coalesce(m[1], m[2]), 8, '0'))::bit(32)::integer;
      v_out := v_out || case when v_c = 0 or v_c between 55296 and 57343 then ' ' else chr(v_c) end;
    end if;
  end loop;
  return normalize(v_out, NFKC);
end
$$;

-- DI-05: the words of text p_text that could name an identifier (header, item 1). Distinct.
create function sandbox.identifier_words(p_text text) returns setof text
language sql immutable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct x.w
    from regexp_matches(sandbox.escapes_decoded(normalize(p_text, NFKC)), '[A-Za-z0-9/.-]*[A-Za-z][A-Za-z0-9/.-]*', 'g') m
   cross join lateral (select btrim(m[1], '/.-') as w) x
   where x.w ~ '[0-9]'
     and x.w !~* '^[0-9]+(st|nd|rd|th)$'
     and x.w !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- DI-05: the words of every string and every member name of JSON value p_value, at any depth (header, item 1). Distinct.
create function sandbox.identifier_words(p_value jsonb) returns setof text
language sql immutable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct w
    from (select s #>> '{}' as t from jsonb_path_query(p_value, 'strict $.** ? (@.type() == "string")') s
          union
          select k #>> '{}' from jsonb_path_query(p_value, 'strict $.** ? (@.type() == "object").keyvalue().key') k) x
   cross join lateral sandbox.identifier_words(x.t) w
$$;

-- DI-05: whether 0810's rule accepts p_word with the reserved prefix as a batch or lot number of a sandbox (it has the
-- form of one).
create function sandbox.has_identifier_form(p_word text) returns boolean
language sql stable set search_path = pg_catalog, sandbox, pg_temp as $$
  select exists (select 1 from sandbox.reserved_identifier_pattern r
                  where r.identifier_kind in ('BATCH_NUMBER', 'LOT_NUMBER')
                    and sandbox.identifier_problem_for('SANDBOX', r.identifier_kind, r.reserved_prefix || p_word) is null)
$$;

-- DI-05: whether 0810's rule reads p_word as a real batch or lot number in a sandbox: it has the form of one and the rule
-- refuses it as it stands.
create function sandbox.is_real_identifier(p_word text) returns boolean
language sql stable set search_path = pg_catalog, sandbox, pg_temp as $$
  select exists (select 1 from sandbox.reserved_identifier_pattern r
                  where r.identifier_kind in ('BATCH_NUMBER', 'LOT_NUMBER')
                    and sandbox.identifier_problem_for('SANDBOX', r.identifier_kind, r.reserved_prefix || p_word) is null
                    and sandbox.identifier_problem_for('SANDBOX', r.identifier_kind, p_word) is not null)
$$;

-- DI-05: what of word p_word (one of sandbox.identifier_words) the rule reads as a real batch or lot number in a sandbox
-- (header, item 1): the word, or for a word too long to be an identifier every run of its parts between separators that
-- holds a letter and a digit and is read so. Empty when nothing is.
create function sandbox.real_identifier_parts(p_word text) returns setof text
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_seg text[] := '{}';
  v_sep text[] := '{}';
  m     text[];
  v_win text;
  i     integer;
  j     integer;
begin
  if p_word is null then
    return;
  end if;
  if sandbox.has_identifier_form(p_word) then
    if sandbox.is_real_identifier(p_word) then
      return next p_word;
    end if;
    return;
  end if;
  for m in select regexp_matches(p_word, '([A-Za-z0-9]+)([/.-]*)', 'g') loop
    v_seg := v_seg || m[1];
    v_sep := v_sep || m[2];
  end loop;
  for i in 1 .. coalesce(cardinality(v_seg), 0) loop
    v_win := '';
    for j in i .. cardinality(v_seg) loop
      v_win := v_win || v_seg[j];
      exit when not sandbox.has_identifier_form(v_win);
      if v_win ~ '[A-Za-z]' and v_win ~ '[0-9]' and v_win !~* '^[0-9]+(st|nd|rd|th)$' and sandbox.is_real_identifier(v_win) then
        return next v_win;
      end if;
      v_win := v_win || v_sep[j];
    end loop;
  end loop;
end
$$;

-- DI-05: the parts of text p_text, and of JSON value p_value, that the rule reads as real batch or lot numbers in a
-- sandbox (header, item 1). Distinct.
create function sandbox.real_identifiers(p_text text) returns setof text
language sql stable set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct p from sandbox.identifier_words(p_text) w cross join lateral sandbox.real_identifier_parts(w) p
$$;

create function sandbox.real_identifiers(p_value jsonb) returns setof text
language sql stable set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct p from sandbox.identifier_words(p_value) w cross join lateral sandbox.real_identifier_parts(w) p
$$;

-- DI-05, INV-18: row trigger for tables whose free text a test, training or simulation run writes (header, item 2):
--   create trigger ac_sandbox_free_text before insert or update of title, body on platform.stub_record
--     for each row execute function sandbox.guard_free_text('title', 'body');
-- Arguments: one or more column names (text, text[] or jsonb). Outside a GMP installation, refuses a row whose named
-- columns hold a word the identifier rule reads as a real batch or lot number. EBMR-SBX-024 (EBMR-SBX-023 for a
-- misconfigured trigger).
create function sandbox.guard_free_text() returns trigger
language plpgsql security definer set search_path = pg_catalog, sandbox, kernel, pg_temp as $$
declare
  v_row  jsonb := to_jsonb(new);
  v_word text;
  i      integer;
begin
  if tg_nargs < 1 then
    raise exception using errcode = 'P0001',
      message = format('Trigger %s on %s.%s must name at least one column (DI-05). [EBMR-SBX-023]', tg_name, tg_table_schema, tg_table_name);
  end if;
  for i in 0 .. tg_nargs - 1 loop
    if not (v_row ? tg_argv[i]) then
      raise exception using errcode = 'P0001',
        message = format('Trigger %s names column %s, which %s.%s does not have (DI-05). [EBMR-SBX-023]', tg_name, tg_argv[i], tg_table_schema, tg_table_name);
    end if;
  end loop;
  if kernel.installation_kind() is not distinct from 'GMP' then
    return new;
  end if;
  for i in 0 .. tg_nargs - 1 loop
    select min(p) into v_word from sandbox.real_identifiers(v_row -> tg_argv[i]) p;
    if v_word is not null then
      raise exception using errcode = 'P0001',
        message = format('%s.%s %s holds a word of the form of a batch or lot number that is not a test one: in the sandbox a text names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, so a real GMP identifier is never reused (DI-05, INV-18). [EBMR-SBX-024]',
                         tg_table_schema, tg_table_name, tg_argv[i]);
    end if;
  end loop;
  return new;
end
$$;

revoke all on function sandbox.escapes_decoded(text), sandbox.identifier_words(text), sandbox.identifier_words(jsonb), sandbox.has_identifier_form(text),
                       sandbox.is_real_identifier(text), sandbox.real_identifier_parts(text), sandbox.real_identifiers(text),
                       sandbox.real_identifiers(jsonb), sandbox.guard_free_text() from public;
grant execute on function sandbox.escapes_decoded(text), sandbox.identifier_words(text), sandbox.identifier_words(jsonb), sandbox.real_identifier_parts(text),
                          sandbox.real_identifiers(text), sandbox.real_identifiers(jsonb) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- The kernel's stub tables (header, item 3)
-- ---------------------------------------------------------------------------------------------

create trigger ab_sandbox_identifier_guard before insert or update of batch_number on market.stub_batch
  for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');
create trigger ab_sandbox_identifier_guard before insert or update of code on market.stub_material_lot
  for each row execute function sandbox.guard_identifier('LOT_NUMBER', 'code');
create trigger ab_sandbox_identifier_guard before insert or update of code on market.stub_pack
  for each row execute function sandbox.guard_identifier('LOT_NUMBER', 'code');

create trigger ac_sandbox_free_text before insert or update of predicates on market.stub_site
  for each row execute function sandbox.guard_free_text('predicates');
create trigger ac_sandbox_free_text before insert or update of predicates on market.stub_product
  for each row execute function sandbox.guard_free_text('predicates');
create trigger ac_sandbox_free_text before insert or update of value, predicates on market.stub_mbr_limit
  for each row execute function sandbox.guard_free_text('value', 'predicates');
create trigger ac_sandbox_free_text before insert or update of title, value, unit on esig.stub_signable
  for each row execute function sandbox.guard_free_text('title', 'value', 'unit');
create trigger ac_sandbox_free_text before insert or update of title, body on platform.stub_record
  for each row execute function sandbox.guard_free_text('title', 'body');
create trigger ac_sandbox_free_text before insert or update of late_reason_text, unit on platform.stub_step_entry
  for each row execute function sandbox.guard_free_text('late_reason_text', 'unit');

reset role;
