-- Tablets server, module C2 (designer): guards the database holds itself for the market set of MBR content and for
-- the warning justifications that validator evidence carries (review findings P13, P15 and P59; controls INV-34,
-- IN-52, INV-28, IN-02, PR-03, DI-04).
--
-- P13. recipe.content_family_problem only asks for distinct two-letter market codes with India among them, and the
-- designer's market-minima adapter only asked the market engine about the rule keys an MBR binds. An MBR binding no
-- key could therefore list a market the engine does not know (say {IN, JP}), resolve no minimum at all and pass. A
-- row trigger on recipe.mbr_content (a2_tab_market_set, after the recipe guard a1_guard) now puts the content's
-- market set through the engine's own check, market.checked_market_set (markets of market.market, each once, India
-- present), whoever inserts the row: a market whose content minima cannot be resolved never enters a master.
--   EBMR-TAB-165  the market set of the content is not one the market engine accepts.
--
-- P15, P59. A justification was taken in force by its finding key alone, whatever content it was written for, and
-- the database stored in VALIDATOR evidence whatever {key, text, by} the server passed. tab.designer_justification
-- already binds each row to the revision and content hash it was written against; now
--  - tab.record_designer_justification gains a form that names the content hash the justification is written for:
--    the row is recorded only while that hash is still the version's latest content (a save in between refuses it,
--    EBMR-TAB-156), so a justification is never recorded against other content than the one it names; the
--    three-argument form, which names none, is no longer granted to the application role. That the named hash is the
--    content the author was shown is for the caller to carry through: the database can only hold the caller to the
--    hash it names;
--  - a row trigger on recipe.mbr_evidence (a2_tab_justifications, after the recipe guard a1_guard, which sets the
--    content hash and the result) turns a VALIDATOR result into FAIL, with the reason among its problems, unless
--    every justification it carries is the one in force for its finding key (the latest recorded for the version),
--    recorded against the version's current revision and content hash, with exactly that text and person. So
--    evidence never shows a justification for content nobody justified, however the server assembled it.
--
-- Privileges: the trigger functions are SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016), and nobody
-- executes them directly. The application role executes only the new four-argument writer.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- P13: the market set of MBR content is one the market engine accepts.

create function tab.mbr_content_market_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, market, pg_temp as $$
declare
  v_markets text[];
begin
  if jsonb_typeof(new.content -> 'header' -> 'marketSet') is distinct from 'array' then
    raise exception using errcode = 'P0001',
      message = 'MBR content without a market set is not saved: its content minima cannot be resolved (IN-52, INV-34). [EBMR-TAB-165]';
  end if;
  v_markets := array(select jsonb_array_elements_text(new.content -> 'header' -> 'marketSet'));
  begin
    perform market.checked_market_set(v_markets);
  exception when raise_exception then
    raise exception using errcode = 'P0001',
      message = format('The market set %s of this MBR content is not one the market engine accepts (%s), so the content minima of its markets cannot be resolved and the content is not saved (IN-52, INV-34). [EBMR-TAB-165]',
                       array_to_string(v_markets, ', '), regexp_replace(sqlerrm, '^\s*EBMR-[A-Z]+-[0-9]{3}\s*', ''));
  end;
  return new;
end
$$;
create trigger a2_tab_market_set before insert on recipe.mbr_content for each row execute function tab.mbr_content_market_guard();

-- ---------------------------------------------------------------------------------------------
-- P15, P59: a justification is recorded against the content it names, never against a later save.

-- Records the author's justification of a warning of the version's latest content, which must still be the content
-- with hash p_content_hash (MBR.AUTHOR in the product scope). Returns {id, revision, content_hash}.
create function tab.record_designer_justification(p_version uuid, p_finding_key text, p_text text, p_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, pg_temp as $$
declare
  j      tab.designer_justification;
  c      record;
begin
  perform iam.assert_not_administrator();
  -- The version row is locked as a content save locks it (recipe.mbr_content_guard), so no revision can be saved
  -- between the check below and the insert, whose guard binds the row to the latest revision.
  perform 1 from recipe.mbr_version where id = p_version for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  select mc.revision, mc.content_hash into c from recipe.mbr_content mc where mc.version_id = p_version order by mc.revision desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = format('MBR version %s has no content to justify. [EBMR-TAB-155]', p_version);
  end if;
  if p_content_hash is null or c.content_hash is distinct from p_content_hash then
    raise exception using errcode = 'P0001',
      message = format('The justification was written for content %s, but the version was saved again (revision %s, content %s); a justification answers the warning of the content it was written for, so it was not recorded (IN-02, DI-04). [EBMR-TAB-156]',
                       left(coalesce(p_content_hash, '(none)'), 12), c.revision, left(c.content_hash, 12));
  end if;
  insert into tab.designer_justification (version_id, finding_key, text, content_revision, content_hash, person_id, account_id, role_code)
  values (p_version, p_finding_key, p_text, 1, repeat('0', 64), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '')
  returning * into j;
  if j.content_revision <> c.revision or j.content_hash <> p_content_hash then
    raise exception using errcode = 'P0001', message = 'The justification was not bound to the content it was written for; nothing was recorded (IN-02, DI-04). [EBMR-TAB-156]';
  end if;
  return jsonb_build_object('id', j.id, 'revision', j.content_revision, 'content_hash', j.content_hash);
end
$$;

-- VALIDATOR evidence carries only the justifications in force for the version's current content.
create function tab.validator_justification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_rev  integer;
  v_bad  text[];
begin
  if new.kind is distinct from 'VALIDATOR' then
    return new;
  end if;
  select mc.revision into v_rev from recipe.mbr_content mc where mc.version_id = new.version_id order by mc.revision desc limit 1;
  v_bad := array(
    select coalesce(j ->> 'key', '(no key)')
      from jsonb_array_elements(case when jsonb_typeof(new.report -> 'justifications') = 'array' then new.report -> 'justifications' else '[]'::jsonb end) j
     where jsonb_typeof(j) is distinct from 'object'
        or not exists (
             select 1
               from (select d.content_revision, d.content_hash, d.text, d.person_id
                       from tab.designer_justification d
                      where d.version_id = new.version_id and d.finding_key = j ->> 'key'
                      order by d.recorded_at desc, d.id desc
                      limit 1) d
              where d.content_revision = v_rev and d.content_hash = new.content_hash
                and d.text = j ->> 'text' and d.person_id::text = j ->> 'by'));
  if cardinality(v_bad) > 0 then
    new.problems := coalesce(new.problems, '{}'::text[]) || format(
      'justifications not recorded for this content (revision %s): %s; a justification answers only the warning of the content it was written for (IN-02, DI-04)',
      coalesce(v_rev::text, '(none)'), array_to_string(v_bad, ', '));
    new.result := 'FAIL';
  end if;
  return new;
end
$$;
create trigger a2_tab_justifications before insert on recipe.mbr_evidence for each row execute function tab.validator_justification_guard();

-- ---------------------------------------------------------------------------------------------
-- Privileges.

revoke all on function tab.mbr_content_market_guard(), tab.validator_justification_guard() from public;
revoke all on function tab.record_designer_justification(uuid, text, text, text) from public;
grant execute on function tab.record_designer_justification(uuid, text, text, text) to ebmr_app;
-- The form that does not name the content is no longer the application's to call: a justification is recorded only
-- against the content hash its caller names, while that is still the saved content. That the named hash is the one
-- the author was shown rests on the caller (the designer's justify request carries it).
revoke execute on function tab.record_designer_justification(uuid, text, text) from ebmr_app;

reset role;
