-- Sandbox, training and simulation store (module A4), part 2: reserved identifiers (control DI-05,
-- invariant INV-18; build outline 6.5 "reserved identifiers").
--
-- Batch numbers, lot numbers and person and device labels made in the sandbox carry the reserved
-- prefix TEST-. The two databases enforce opposite rules, so their identifier sets never overlap:
--   * a GMP database refuses any identifier whose NFKC form, after leading ASCII white space, starts
--     with the prefix in any letter case (so TEST-, test-, full-width or circled look-alikes);
--   * a sandbox database accepts only identifiers that match the kind's sandbox pattern: ASCII only,
--     starting with the prefix. A real GMP batch or lot number is therefore never reused in the sandbox.
-- Every sandbox pattern starts with ^ and the prefix and allows only ASCII (table constraints), so an
-- identifier the sandbox accepts is always one the GMP database refuses.
--
-- Other modules call sandbox.assert_identifier_allowed(kind, value) in their writers, or attach the
-- trigger function sandbox.guard_identifier(kind, column [, column ...]) to their tables. The same
-- rules are mirrored in TypeScript (src/sandbox/identifiers.ts) for screens; a test proves both agree.

set local role ebmr_owner;

-- Upper-cases ASCII letters only (independent of locale and of Unicode case mappings).
create function sandbox.ascii_upper(p_value text) returns text
language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $$
  select translate(p_value, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
$$;

create table sandbox.reserved_identifier_pattern (
  identifier_kind  text primary key check (identifier_kind ~ '^[A-Z][A-Z_]{2,39}$'),
  label            text not null check (label ~ '^[a-z][a-z ]{2,39}$'),
  reserved_prefix  text not null check (reserved_prefix ~ '^[A-Z]{2,8}-$'),
  -- Matched against the ASCII-upper-cased value.
  sandbox_pattern  text not null check (sandbox_pattern ~ '^[ -~]+$'),
  example          text not null,
  description      text not null check (btrim(description) <> ''),
  check (starts_with(sandbox_pattern, '^' || reserved_prefix)),
  check (sandbox.ascii_upper(example) ~ sandbox_pattern)
);
revoke all on sandbox.reserved_identifier_pattern from public;
grant select on sandbox.reserved_identifier_pattern to ebmr_app;

insert into sandbox.reserved_identifier_pattern (identifier_kind, label, reserved_prefix, sandbox_pattern, example, description) values
  ('BATCH_NUMBER', 'batch number', 'TEST-', '^TEST-[A-Z0-9][A-Z0-9/.-]{0,26}$', 'TEST-B24-0001',
   'Sandbox test-run and training batch numbers; at most 32 characters, within the site batch-number format.'),
  ('LOT_NUMBER', 'lot number', 'TEST-', '^TEST-[A-Z0-9][A-Z0-9/.-]{0,26}$', 'TEST-L24-0001',
   'Sandbox material lots, containers and output lots; never a real lot number.'),
  ('PERSON_LABEL', 'person label', 'TEST-', '^TEST-[A-Z0-9][A-Z0-9 ._''-]{0,62}$', 'TEST-TRAINEE-01',
   'Login names and displayed names of training and test persons, so a sandbox signature never shows a real name alone.'),
  ('DEVICE_LABEL', 'device label', 'TEST-', '^TEST-[A-Z0-9][A-Z0-9._-]{0,57}$', 'TEST-SCALE-01',
   'Codes of terminals, scales and instruments registered in the sandbox.');

-- The problem with an identifier in an installation of the given kind, or null when it is allowed.
-- A null value is not checked (NOT NULL is the owning table's rule).
create function sandbox.identifier_problem_for(p_installation text, p_kind text, p_value text) returns text
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  r sandbox.reserved_identifier_pattern;
  v_shown text;
begin
  if p_installation is null or p_installation not in ('GMP', 'SANDBOX') then
    raise exception using errcode = 'P0001',
      message = format('Unknown installation kind %s: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]', coalesce(p_installation, 'null'));
  end if;
  select * into r from sandbox.reserved_identifier_pattern where identifier_kind = p_kind;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('Unknown identifier kind %s: no reserved test pattern is registered for it (DI-05). [EBMR-SBX-020]', coalesce(p_kind, 'null'));
  end if;
  if p_value is null then
    return null;
  end if;
  v_shown := left(p_value, 64);
  if p_installation = 'GMP' then
    if starts_with(sandbox.ascii_upper(ltrim(normalize(p_value, NFKC), ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13))),
                   r.reserved_prefix) then
      return format('"%s" is a reserved test %s (prefix %s): a GMP database never accepts sandbox, training or simulation identifiers (DI-05, INV-18). [EBMR-SBX-021]',
                    v_shown, r.label, r.reserved_prefix);
    end if;
    return null;
  end if;
  if sandbox.ascii_upper(p_value) !~ r.sandbox_pattern then
    return format('"%s" is not a test %s: in the sandbox every %s starts with %s (for example %s), so a real GMP identifier is never reused (DI-05). [EBMR-SBX-022]',
                  v_shown, r.label, r.label, r.reserved_prefix, r.example);
  end if;
  return null;
end
$$;

-- The same for this installation.
create function sandbox.identifier_problem(p_kind text, p_value text) returns text
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
begin
  return sandbox.identifier_problem_for(kernel.installation_kind(), p_kind, p_value);
end
$$;

create function sandbox.assert_identifier_allowed(p_kind text, p_value text) returns void
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_problem text := sandbox.identifier_problem(p_kind, p_value);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
end
$$;

-- Row trigger for tables that store identifiers:
--   create trigger zz_reserved_identifiers before insert or update on site.batch_number_allocation
--     for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');
-- Arguments: the identifier kind, then one or more column names of that kind.
create function sandbox.guard_identifier() returns trigger
language plpgsql security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_row jsonb := to_jsonb(new);
  i integer;
begin
  if tg_nargs < 2 then
    raise exception using errcode = 'P0001',
      message = format('Trigger %s on %s.%s must name an identifier kind and at least one column (DI-05). [EBMR-SBX-023]', tg_name, tg_table_schema, tg_table_name);
  end if;
  for i in 1 .. tg_nargs - 1 loop
    if not (v_row ? tg_argv[i]) then
      raise exception using errcode = 'P0001',
        message = format('Trigger %s names column %s, which %s.%s does not have (DI-05). [EBMR-SBX-023]', tg_name, tg_argv[i], tg_table_schema, tg_table_name);
    end if;
    perform sandbox.assert_identifier_allowed(tg_argv[0], v_row ->> tg_argv[i]);
  end loop;
  return new;
end
$$;

grant execute on function sandbox.ascii_upper(text), sandbox.identifier_problem_for(text, text, text),
                          sandbox.identifier_problem(text, text), sandbox.assert_identifier_allowed(text, text) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- INV-18, second half: where a batch may come from
-- ---------------------------------------------------------------------------------------------

-- p_market_states: the state of the pinned MBR version for each market of the batch's market set
-- (CURRENT, BRIDGING, SUPERSEDED, WITHDRAWN, or the version's own state when it has no authorisation
-- yet, e.g. IN_VERIFICATION). Returns null when issue may proceed in this kind of installation.
--   * GMP: the version must be CURRENT or BRIDGING for every market (the MBR life cycle's selection
--     function chooses it; this is the last check at issue).
--   * SANDBOX: any version with content may be test-run (that is how IN_VERIFICATION evidence is
--     gathered), but the batch number must be a reserved test number.
create function sandbox.batch_issue_problem_for(p_installation text, p_market_states text[]) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_bad text;
begin
  if p_installation is null or p_installation not in ('GMP', 'SANDBOX') then
    raise exception using errcode = 'P0001',
      message = format('Unknown installation kind %s: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]', coalesce(p_installation, 'null'));
  end if;
  if p_market_states is null or cardinality(p_market_states) = 0 then
    return 'A batch needs an MBR version and at least one market (INV-18). [EBMR-SBX-012]';
  end if;
  if p_installation = 'SANDBOX' then
    return null;
  end if;
  select string_agg(distinct coalesce(s, 'none') collate "C", ', ' order by coalesce(s, 'none') collate "C") into v_bad
    from unnest(p_market_states) s where s is null or s not in ('CURRENT', 'BRIDGING');
  if v_bad is not null then
    return format('A GMP batch is issued only from an MBR version that is CURRENT or BRIDGING for every market of the batch; found %s. Test runs of other versions belong in the sandbox (DI-05, INV-18). [EBMR-SBX-012]', v_bad);
  end if;
  return null;
end
$$;

create function sandbox.assert_batch_issue_allowed(p_market_states text[]) returns void
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_problem text := sandbox.batch_issue_problem_for(kernel.installation_kind(), p_market_states);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
end
$$;

grant execute on function sandbox.batch_issue_problem_for(text, text[]), sandbox.assert_batch_issue_allowed(text[]) to ebmr_app;

reset role;
