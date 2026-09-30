-- Recipe core: a market-authorisation command, and the retirement of an MBR version by whatever path, carries the
-- reason of the person who gives it, both halves; recipe code writes no half of it (DI-22, DI-24; EBMR-AUDIT-002).
--
-- The kernel's audit trigger (kernel 0010) refuses an UPDATE or DELETE of an audited row unless the command
-- context carries a reason code and a reason text, neither blank (outline 5.4). Migration 0250 stopped
-- recipe code from writing a reason for the three user edits that used recipe.push_reason (draft attributes,
-- batch issue, batch status). It left push_reason in place for the authorisation cells that three QA commands
-- end (0160), on the view that those updates only follow from another act:
--   activate_market_authorisation  supersedes the predecessor's CURRENT cell of the same market and scope; a
--                                  command with no reason code committed that UPDATE with the code
--                                  MBR_SUPERSEDED, and with a text the system wrote when the command gave none;
--   withdraw_market_authorisation  ends the record's open cells; a command with no reason code committed them
--                                  with the code MBR_AUTHORISATION_WITHDRAWN next to the withdrawal's text;
--   retire_version                 ends every open cell of the version (code MBR_RETIRED); the RETIRE
--                                  transition's guard then refused a command with no reason code, but a
--                                  command with a code and no text retired a version that had no open cell.
-- The RETIRE transition itself is open to the application: platform.transition is granted to ebmr_app (kernel
-- 0550), and its guards were platform.reason_given (the code alone) and mbr_version.no_open_authorisation. A
-- direct RETIRE of a version with no open cell, with a code and a blank text, committed; the engine then wrote
-- the text of the state row's audit entry itself ('RETIRE: APPROVED -> RETIRED', platform.engine_reason).
-- Each of these is a decision a QA person takes and signs or states, not a side effect. The audit entry of the
-- change must record why that person made it (DI-22), in their own words, and not a description the system
-- wrote so that the reason check passes.
--
-- From this migration on:
--   * recipe.reason_is_blank is the recipe's test of a blank reason half: NULL, or nothing but white space,
--     control characters and invisible format characters. It is stricter than the kernel's kernel.is_blank
--     (0010), which in this database's character classes counts the no-break space U+00A0 and the zero-width
--     space U+200B as text: a reason made of those says nothing and is refused here;
--   * recipe.require_own_reason refuses the command unless its validated context carries a reason code and a
--     reason text, neither blank by that test (EBMR-AUDIT-002, the kernel's rule code, leads the message as in
--     the kernel's own refusals). Each of the three commands calls it right after its permission check, before
--     anything is locked or written, so the requirement does not depend on whether there is a cell to end: a
--     first activation needs the reason as much as a successor's;
--   * the guard mbr_version.no_open_authorisation, the machine's recipe guard of APPROVED -RETIRE-> RETIRED and
--     of no other transition, also refuses the transition unless the command carries both halves by the same
--     test. So a RETIRE through platform.transition directly needs the QA person's own reason exactly as
--     recipe.retire_version does, and the engine never has a blank half to complete for it. The machine's
--     sealed hash covers guard codes only (kernel 0550 machine_canonical_text); the code, its binding and the
--     function's identity are unchanged, and the guard is registered again with a description that says so;
--   * a withdrawal's stated reason (market_authorisation_withdrawal.reason, EBMR-RCP-084) is blank by the same
--     test too;
--   * the cells are superseded or ended in the command's own context, unchanged, so their audit entries record
--     exactly the reason the person gave; the kernel's check still applies to each UPDATE;
--   * recipe.end_open_cells takes no reason any more (the four-argument form is dropped);
--   * recipe.push_reason and recipe.restore_actor are dropped. No recipe function called them any more (0250
--     replaced the three user edits), so no recipe code can complete a reason for anyone.
--
-- Applied as a new migration because applied migrations are checksummed and never edited. Apart from the
-- reason, each command and the guard are exactly as they were: same checks, same order, same messages.
-- CREATE OR REPLACE keeps owner, privileges, SECURITY DEFINER (or not, for the guard) and search_path as 0130 and
-- 0160 set them (execute for ebmr_app on the three commands; the guard private to the owner); the new helpers
-- and the new end_open_cells stay private to the owner (no execute for PUBLIC by the owner's default
-- privileges, 0001).

set local role ebmr_owner;

-- A blank reason half: NULL, the kernel's blank (kernel.is_blank), or nothing but white space (Unicode White_Space,
-- C0 and C1 controls), invisible format characters (zero-width spaces and joiners, bidirectional marks, word joiner,
-- byte order mark, variation selectors, tags) and the blank fillers (Hangul fillers, Braille blank).
create function recipe.reason_is_blank(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p is null or kernel.is_blank(p)
      or pg_catalog.regexp_replace(p,
           '[\u0001-\u0020\u007f-\u00a0\u00ad\u034f\u061c\u115f\u1160\u1680\u17b4\u17b5\u180b-\u180f\u2000-\u200f\u2028-\u202f\u205f-\u206f\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]',
           '', 'g') = ''
$$;

-- The validated context of the command, or a refusal when it lacks the reason code or the reason text of the
-- person giving it (`p_act` names the act for the message). Never completes either half.
create function recipe.require_own_reason(p_act text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v jsonb := recipe.require_actor();
begin
  if recipe.reason_is_blank(v ->> 'reason_code') or recipe.reason_is_blank(v ->> 'reason_text') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-AUDIT-002 %s needs the reason of the person who gives it: a reason code and a reason text, neither blank. '
                       'The system writes no part of it (DI-22, DI-24)', p_act);
  end if;
  return v;
end
$$;

-- Ends every open cell of one record or one version: CURRENT and BRIDGING become WITHDRAWN, valid until now (or
-- until their start, when they had not started yet). The UPDATE runs in the command's own context: the kernel
-- refuses it unless the command gave both halves of its reason.
drop function recipe.end_open_cells(uuid, uuid, text, text);
create function recipe.end_open_cells(p_where_authorisation uuid, p_where_version uuid) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
  v_n   integer;
begin
  update recipe.authorisation_cell c
  set status = 'WITHDRAWN',
      valid_until = case when c.kind = 'BRIDGING' then least(c.valid_until, greatest(v_now, c.effective_from)) else greatest(v_now, c.effective_from) end
  where c.status in ('CURRENT', 'BRIDGING')
    and (p_where_authorisation is null or c.authorisation_id = p_where_authorisation)
    and (p_where_version is null or c.version_id = p_where_version);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Activates a proposed record with its two signatures (the QA signer runs the command). CURRENT:
-- supersedes the predecessor per scope cell; BRIDGING: only for cells where the named successor
-- superseded this version.
create or replace function recipe.activate_market_authorisation(p_authorisation uuid, p_qa_signature uuid, p_regulatory_signature uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, esig, kernel, pg_temp as $$
declare
  a       recipe.market_authorisation;
  v       recipe.mbr_version;
  v_ctx   jsonb;
  v_now   timestamptz := clock_timestamp();
  v_from  timestamptz;
  v_qa    jsonb;
  v_reg   jsonb;
  v_ev    jsonb;
  x       jsonb;
  v_old   recipe.authorisation_cell;
  v_other recipe.authorisation_cell;
  v_new   uuid;
  v_out   jsonb := '[]'::jsonb;
begin
  perform iam.assert_not_administrator();
  select * into a from recipe.market_authorisation where id = p_authorisation for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown market authorisation %s (EBMR-RCP-083)', p_authorisation);
  end if;
  v_ctx := iam.require_permission('MBR.APPROVE', recipe.version_scope(a.version_id));
  -- DI-22, DI-24: the QA person's own reason, both halves; recipe code writes no half of it (0290).
  perform recipe.require_own_reason('the activation of a market authorisation');
  -- One activation at a time per family (INV-17).
  perform 1 from recipe.mbr_family where id = a.family_id for update;
  if recipe.market_authorisation_state(a.id) <> 'PROPOSED' then
    raise exception using errcode = 'P0001',
      message = format('This authorisation is %s; only a PROPOSED record is activated (EBMR-RCP-083)', recipe.market_authorisation_state(a.id));
  end if;
  -- DI-37: both signatures valid for this record; QA is the person activating; two different persons.
  v_qa := esig.assert_signature(p_qa_signature, 'MBR_MARKET_AUTHORISED', 'mbr_market_authorisation', a.id::text);
  v_reg := esig.assert_signature(p_regulatory_signature, 'REGULATORY_CONFIRMED', 'mbr_market_authorisation', a.id::text);
  if (v_qa ->> 'signer_person') is distinct from (v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001', message = 'The QA person who signed the authorisation activates it (DI-37; EBMR-RCP-085)';
  end if;
  if (v_reg ->> 'signer_person') = (v_qa ->> 'signer_person') then
    raise exception using errcode = 'P0001',
      message = 'QA and the regulatory-conformity signer are two different persons (ADR 0014; EBMR-RCP-085)';
  end if;
  select * into v from recipe.mbr_version where id = a.version_id;
  -- Locked: a concurrent RETIRE or WITHDRAW of the version waits for this activation, or this one sees it.
  if recipe.version_state_locked(v.id) is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('Version %s is %s: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)', v.version_number, recipe.version_state(v.id));
  end if;
  v_ev := recipe.evidence_status(v.id);
  if not (v_ev ->> 'complete')::boolean then
    raise exception using errcode = 'P0001',
      message = format('The version has no complete verification record for its content (%s); it cannot become effective for a market (DI-04; EBMR-RCP-087)',
                       (select string_agg(m, '; ') from jsonb_array_elements_text(v_ev -> 'missing') m));
  end if;
  -- Never before the activation, never before the version's own effective date (PR-02).
  v_from := greatest(coalesce(a.effective_from, v_now), v_now, v.effective_from);
  if a.kind = 'BRIDGING' and a.effective_to <= v_from then
    raise exception using errcode = 'P0001', message = 'The bridging window has already ended (INV-17; EBMR-RCP-082)';
  end if;
  insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
  values (a.id, p_qa_signature, p_regulatory_signature, v_from, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');

  -- The predecessor's cell is superseded in the command's own context: its audit entry records the QA
  -- person's reason exactly as given (0290).
  for x in select * from jsonb_array_elements(a.cells) loop
    v_new := gen_random_uuid();
    if a.kind = 'CURRENT' then
      select * into v_old from recipe.authorisation_cell c
      where c.family_id = a.family_id and c.market = a.market and c.site = x ->> 'site' and c.line = x ->> 'line'
        and c.batch_size = x ->> 'batch_size' and c.status = 'CURRENT'
      for update;
      if found then
        if v_old.version_id = v.id then
          raise exception using errcode = 'P0001',
            message = format('Version %s is already CURRENT for %s at %s', v.version_number, a.market, x) || ' (INV-17; EBMR-RCP-088)';
        end if;
        if v_old.version_number > v.version_number then
          raise exception using errcode = 'P0001',
            message = format('The newer version %s is CURRENT for %s at %s; an older version cannot supersede it (PR-05; EBMR-RCP-089)',
                             v_old.version_number, a.market, x);
        end if;
        if v_old.effective_from > v_from then
          raise exception using errcode = 'P0001',
            message = format('Version %s takes effect for %s at %s only from %s; its successor cannot take effect before it (INV-17; EBMR-RCP-089)',
                             v_old.version_number, a.market, x, recipe.utc_text(v_old.effective_from));
        end if;
        update recipe.authorisation_cell set status = 'SUPERSEDED', valid_until = v_from, superseded_by = v_new where id = v_old.id;
      end if;
      -- A predecessor superseded by a version that was later withdrawn before taking effect stays
      -- valid until then: the new version cannot take effect inside that window (INV-17).
      select * into v_other from recipe.authorisation_cell c
      where c.family_id = a.family_id and c.market = a.market and c.site = x ->> 'site' and c.line = x ->> 'line'
        and c.batch_size = x ->> 'batch_size' and c.kind = 'CURRENT' and tstzrange(c.effective_from, c.valid_until, '[)') && tstzrange(v_from, null, '[)')
      limit 1;
      if found then
        raise exception using errcode = 'P0001',
          message = format('Version %s remains valid for %s at %s until %s; a new version can take effect for that scope only after it (INV-17; EBMR-RCP-093)',
                           v_other.version_number, a.market, x, recipe.utc_text(v_other.valid_until));
      end if;
      insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind,
                                             status, effective_from, valid_until, successor_version_id)
      values (v_new, a.id, a.family_id, v.id, v.version_number, a.market, x ->> 'site', x ->> 'line', x ->> 'batch_size', 'CURRENT',
              'CURRENT', v_from, null, null);
    else
      if not exists (select 1 from recipe.authorisation_cell c join recipe.authorisation_cell s on s.id = c.superseded_by
                     where c.version_id = v.id and c.market = a.market and c.site = x ->> 'site' and c.line = x ->> 'line'
                       and c.batch_size = x ->> 'batch_size' and c.status = 'SUPERSEDED' and s.version_id = a.successor_version_id) then
        raise exception using errcode = 'P0001',
          message = format('BRIDGING is given only where the named successor superseded this version: not the case for %s at %s (ADR 0014; EBMR-RCP-090)', a.market, x);
      end if;
      select * into v_other from recipe.authorisation_cell c
      where c.family_id = a.family_id and c.market = a.market and c.site = x ->> 'site' and c.line = x ->> 'line'
        and c.batch_size = x ->> 'batch_size' and c.kind = 'BRIDGING' and tstzrange(c.effective_from, c.valid_until, '[)') && tstzrange(v_from, a.effective_to, '[)')
      limit 1;
      if found then
        raise exception using errcode = 'P0001',
          message = format('A BRIDGING validity of version %s already covers %s at %s until %s; withdraw it before giving another (INV-17; EBMR-RCP-093)',
                           v_other.version_number, a.market, x, recipe.utc_text(v_other.valid_until));
      end if;
      insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind,
                                             status, effective_from, valid_until, successor_version_id)
      values (v_new, a.id, a.family_id, v.id, v.version_number, a.market, x ->> 'site', x ->> 'line', x ->> 'batch_size', 'BRIDGING',
              'BRIDGING', v_from, a.effective_to, a.successor_version_id);
    end if;
    v_out := v_out || jsonb_build_object('cell_id', v_new, 'site', x ->> 'site', 'line', x ->> 'line', 'batch_size', x ->> 'batch_size',
                                         'superseded_cell_id', case when a.kind = 'CURRENT' and v_old.id is not null then v_old.id end);
    v_old := null;
  end loop;
  perform kernel.audit_business_event('mbr_version:' || v.id,
    format('version %s is %s for market %s from %s (%s scope cells)', v.version_number, a.kind, a.market, recipe.utc_text(v_from), jsonb_array_length(a.cells)),
    jsonb_build_object('authorisation_id', a.id, 'cells', v_out));
  return jsonb_build_object('authorisation_id', a.id, 'version_id', v.id, 'market', a.market, 'kind', a.kind,
                            'effective_from', recipe.utc_text(v_from), 'cells', v_out);
end
$$;

create or replace function recipe.withdraw_market_authorisation(p_authorisation uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  a    recipe.market_authorisation;
  v_n  integer;
begin
  perform iam.assert_not_administrator();
  select * into a from recipe.market_authorisation where id = p_authorisation for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown market authorisation %s (EBMR-RCP-083)', p_authorisation);
  end if;
  perform iam.require_permission('MBR.APPROVE', recipe.version_scope(a.version_id));
  -- DI-22, DI-24: the QA person's own reason, both halves; recipe code writes no half of it (0290).
  perform recipe.require_own_reason('the withdrawal of a market authorisation');
  perform 1 from recipe.mbr_family where id = a.family_id for update;
  -- The stated reason is blank by the recipe's test too (0290): white space or invisible characters say nothing.
  if recipe.reason_is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'A withdrawal states its reason (EBMR-RCP-084)';
  end if;
  if recipe.market_authorisation_state(a.id) = 'WITHDRAWN' then
    raise exception using errcode = 'P0001', message = 'This authorisation is already withdrawn (EBMR-RCP-084)';
  end if;
  insert into recipe.market_authorisation_withdrawal (authorisation_id, reason, person_id, account_id)
  values (a.id, p_reason, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
  v_n := recipe.end_open_cells(a.id, null);
  return jsonb_build_object('authorisation_id', a.id, 'cells_ended', v_n);
end
$$;

-- CURRENT -> RETIRED by QA (outline 5.2.1; PR-05): ends every open cell of the version, then makes
-- the RETIRE transition (which needs the QA person's own reason and no open cell). Batches already issued keep
-- their pin.
create or replace function recipe.retire_version(p_version uuid, p_expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, platform, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.APPROVE', coalesce(recipe.version_scope(p_version), '{}'::jsonb));
  -- DI-22, DI-24: the QA person's own reason, both halves; recipe code writes no half of it (0290).
  perform recipe.require_own_reason('the retirement of an MBR version');
  if recipe.version_state(p_version) = 'APPROVED' then
    perform 1 from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where v.id = p_version for update of f;
    perform recipe.end_open_cells(null, p_version);
  end if;
  return platform.transition('mbr_version', 'mbr_version', p_version, 'RETIRE', p_expected_version, '{}'::jsonb);
end
$$;

-- The guard of APPROVED -RETIRE-> RETIRED (and of no other transition, 0140): the command carries the QA person's
-- own reason, both halves, and no market authorisation of the version is still open. The reason is checked here
-- because the RETIRE transition is open to the application through platform.transition, whose kernel guard
-- platform.reason_given checks the code alone, and whose engine completes a blank text (kernel 0550).
create or replace function recipe.guard_no_open_authorisation(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if recipe.reason_is_blank(p_actor ->> 'reason_code') or recipe.reason_is_blank(p_actor ->> 'reason_text') then
    return 'the retirement needs the reason of the QA person who retires the version: a reason code and a reason text, neither blank; '
           'the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)';
  end if;
  if exists (select 1 from recipe.authorisation_cell c where c.version_id = p_id and c.status in ('CURRENT', 'BRIDGING')) then
    return 'the version is still CURRENT or BRIDGING for a market: retire it through recipe.retire_version, which ends those authorisations in the same command (PR-05)';
  end if;
  return null;
end
$$;

select platform.register_guard('mbr_version.no_open_authorisation', 'recipe.guard_no_open_authorisation(text, uuid, jsonb, jsonb, jsonb)',
  'The command carries the QA person''s own reason, code and text (DI-22, DI-24), and no market authorisation of the version is still CURRENT or BRIDGING (PR-05)');

-- No recipe function completes a reason for anyone any more.
drop function recipe.push_reason(text, text);
drop function recipe.restore_actor(jsonb);

-- Privileges: CREATE OR REPLACE keeps those of 0130 and 0160 (execute for ebmr_app on the three commands; the guard
-- private to the owner). reason_is_blank, require_own_reason and end_open_cells stay private to the owner.

reset role;
