-- Recipe core, MBR life cycle (A3), part 4: what an MBR version's signatures cover (content
-- provider), the tables whose change supersedes them (INV-09 through the e-signature module), the
-- comparisons change control needs (PR-04 registered ranges, PR-06 process impact) and the guards of
-- the mbr_version machine (outline 5.2.1), registered with platform.register_guard.
--
-- Guards run inside platform.transition with the version's state row locked; each returns NULL when
-- it passes, otherwise a plain-language reason naming the rule and control. They never write.
-- Machine and guard table (generated seed 0140_machine_mbr_version_v1.sql):
--
--   DRAFT            START_VERIFICATION -> IN_VERIFICATION   mbr.author        content_present, validator_passed
--                    WITHDRAW -> WITHDRAWN                   mbr.author        reason
--   IN_VERIFICATION  SUBMIT -> SUBMITTED  Sig PREPARED       mbr.sign_prepared signed_in_state, prepared_by_author,
--                                                                              evidence_complete, change_record_linked,
--                                                                              critical_elements_risk_assessed
--                    RETURN -> DRAFT                         mbr.author        reason, draft_entry_recorded
--                    WITHDRAW -> WITHDRAWN                   mbr.author        reason
--   SUBMITTED        CHECK -> CHECKED     Sig CHECKED        mbr.check         signed_in_state, checker_independent
--                    RETURN -> DRAFT                         mbr.check         reason, draft_entry_recorded
--                    WITHDRAW -> WITHDRAWN                   mbr.approve       reason
--   CHECKED          APPROVE -> APPROVED  Sig APPROVED       mbr.approve       signed_in_state, approver_independent,
--                                                                              regulatory_confirmed,
--                                                                              evidence_complete, effective_date_set,
--                                                                              review_due_set, change_control_complete,
--                                                                              registered_ranges_kept, in_flight_dispositioned
--                    RETURN -> DRAFT                         mbr.approve       reason, draft_entry_recorded
--                    WITHDRAW -> WITHDRAWN                   mbr.approve       reason
--   APPROVED         RETIRE -> RETIRED                       mbr.approve       reason, no_open_authorisation
--                    WITHDRAW -> WITHDRAWN                   mbr.approve       reason, never_authorised
--
-- APPROVED never returns to DRAFT: an approved master's content never changes (PR-06); a change
-- is a new version derived from it.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- What the signatures of an MBR version cover (content-provider contract: esig 0200)
-- ---------------------------------------------------------------------------------------------
-- content = the MBR content hash plus the version's key fields: family identity, version number,
-- content revision, draft cycle, author, predecessor, change record, linked risk assessments,
-- effective date, periodic-review due date and the verification evidence of the current hash.
-- Any change to these (a content revision, a draft attribute, a risk link, evidence, a return to
-- DRAFT) goes through a registered signed table, so esig supersedes every signature in the same
-- transaction (INV-09, DI-37). content_version counts the version's log rows (monotonic).

create function recipe.mbr_version_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v  recipe.mbr_version;
  f  recipe.mbr_family;
  c  recipe.mbr_content;
begin
  if coalesce(p_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into v from recipe.mbr_version where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  c := recipe.current_content(v.id);
  if c.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from recipe.mbr_family where id = v.family_id;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from recipe.mbr_version_log l where l.version_id = v.id),
    'content', jsonb_build_object(
      'family', jsonb_build_object('code', f.code, 'title', f.title, 'edition', f.edition, 'record_kind', f.record_kind,
                                   'product_code', f.product_code, 'product_name', f.product_name, 'strength', f.strength,
                                   'dosage_form', f.dosage_form, 'batch_sizes', f.batch_sizes),
      'version_id', v.id,
      'version_number', v.version_number::text,
      'content_hash', c.content_hash,
      'content_revision', c.revision::text,
      'draft_cycle', recipe.current_cycle(v.id)::text,
      'author_person', v.author_person,
      'derived_from', (select jsonb_build_object('version_id', p.id, 'version_number', p.version_number::text,
                                                 'content_hash', recipe.content_hash_of(p.id))
                       from recipe.mbr_version p where p.id = v.derived_from),
      'change_record', (select jsonb_build_object('id', r.id, 'number', r.number, 'title', r.title, 'change_class', r.change_class,
                                                  'process_impacting', r.process_impacting)
                        from recipe.change_record r where r.id = v.change_record_id),
      'risk_assessments', (select coalesce(jsonb_agg(jsonb_build_object('id', l.risk_assessment_id, 'code', l.code, 'version', l.version,
                                                                        'risk_class', l.risk_class, 'rationale_ref', l.rationale_ref,
                                                                        'subjects', to_jsonb(l.subjects))
                                                     order by l.code, l.version), '[]'::jsonb)
                           from recipe.current_risk_links(v.id) l),
      'effective_from', recipe.utc_text(v.effective_from),
      'review_due', to_char(v.review_due, 'YYYY-MM-DD'),
      'evidence', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'mode', e.mode, 'result', e.result,
                                                                'report_hash', e.report_hash, 'tool_version', e.tool_version,
                                                                'reference', e.reference)
                                             order by e.kind), '[]'::jsonb)
                   from recipe.current_evidence(v.id) e)),
    'state', recipe.version_state(v.id),
    'scope', jsonb_build_object('product', f.product_code),
    'entered_by', to_jsonb(recipe.editors_since_draft(v.id)));
end
$$;

select esig.register_content_provider('mbr_version', 'recipe.mbr_version_content(text)',
  'MBR version: content hash and key fields (family, number, cycle, author, predecessor, change record, risk links, effective and review dates, evidence)');
select esig.register_signed_table('recipe.mbr_version', 'mbr_version', 'id', array['change_record_id', 'effective_from', 'review_due']);
select esig.register_signed_table('recipe.mbr_content', 'mbr_version', 'version_id');
select esig.register_signed_table('recipe.mbr_draft_entry', 'mbr_version', 'version_id');
select esig.register_signed_table('recipe.mbr_risk_link', 'mbr_version', 'version_id');
select esig.register_signed_table('recipe.mbr_evidence', 'mbr_version', 'version_id');
select esig.register_signed_table('recipe.mbr_evidence_void', 'mbr_version', 'version_id');

-- ---------------------------------------------------------------------------------------------
-- Comparisons with the baseline (PR-04, PR-06)
-- ---------------------------------------------------------------------------------------------

-- The versions a new version is compared with: the version it was derived from and the newest
-- lower-numbered version of the family that was ever approved (the registered state in use), so a
-- version derived from an old one cannot slip a change past the current master.
create function recipe.baseline_versions(p_version uuid) returns setof uuid
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select v.derived_from from recipe.mbr_version v where v.id = p_version and v.derived_from is not null
  union
  select b.id from recipe.mbr_version v
  join lateral (select o.id from recipe.mbr_version o
                where o.family_id = v.family_id and o.version_number < v.version_number and recipe.version_was_approved(o.id)
                order by o.version_number desc limit 1) b on true
  where v.id = p_version
$$;

-- REGISTERED-tier ranges of a content: parameters, calculations and yield checkpoints (limits) and
-- acceptance criteria (range), as exact numerics.
create function recipe.registered_ranges(p_content jsonb)
returns table (subject text, unit text, low numeric, low_inclusive boolean, high numeric, high_inclusive boolean)
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  with items as (
    select x ->> 'id' as subject, x -> 'limits' ->> 'unit' as unit, r as range
    from jsonb_array_elements(coalesce(p_content -> 'parameters', '[]') || coalesce(p_content -> 'calculations', '[]')
                              || coalesce(p_content -> 'yieldCheckpoints', '[]')) x
    cross join lateral jsonb_array_elements(case when jsonb_typeof(x -> 'limits' -> 'ranges') = 'array' then x -> 'limits' -> 'ranges' else '[]' end) r
    union all
    select (s ->> 'id') || '/' || (c ->> 'id'), c ->> 'unit', c -> 'range'
    from jsonb_array_elements(coalesce(p_content -> 'acceptanceSchemes', '[]')) s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s -> 'criteria') = 'array' then s -> 'criteria' else '[]' end) c
  )
  select i.subject, i.unit,
         case when recipe.is_decimal(i.range -> 'low' ->> 'value') then (i.range -> 'low' ->> 'value')::numeric end,
         coalesce((i.range -> 'low' ->> 'inclusive')::boolean, false),
         case when recipe.is_decimal(i.range -> 'high' ->> 'value') then (i.range -> 'high' ->> 'value')::numeric end,
         coalesce((i.range -> 'high' ->> 'inclusive')::boolean, false)
  from items i
  where i.range ->> 'tier' = 'REGISTERED'
$$;

-- Changes of registered elements between two contents (PR-04). widened = the new range admits a
-- value the old one refused (bound removed or moved outward, strict bound made inclusive, range
-- removed, unit changed so the ranges cannot be compared). Registration references (kind
-- REGISTRATION) added, removed or re-versioned are changes too.
create function recipe.registered_changes(p_before jsonb, p_after jsonb)
returns table (subject text, change text, widened boolean)
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  with b as (select * from recipe.registered_ranges(p_before)), a as (select * from recipe.registered_ranges(p_after)),
  pairs as (select coalesce(b.subject, a.subject) as subject, b.subject is not null as had, a.subject is not null as has,
                   b.unit as bu, a.unit as au, b.low as bl, b.low_inclusive as bli, b.high as bh, b.high_inclusive as bhi,
                   a.low as al, a.low_inclusive as ali, a.high as ah, a.high_inclusive as ahi
            from b full join a on a.subject = b.subject)
  select p.subject,
         case when not p.has then 'registered range removed'
              when not p.had then 'registered range added'
              when p.bu is distinct from p.au then format('registered range unit changed from %s to %s', p.bu, p.au)
              else format('registered range changed from %s%s, %s%s to %s%s, %s%s',
                          case when p.bli then '[' else '(' end, coalesce(p.bl::text, '-inf'), coalesce(p.bh::text, '+inf'), case when p.bhi then ']' else ')' end,
                          case when p.ali then '[' else '(' end, coalesce(p.al::text, '-inf'), coalesce(p.ah::text, '+inf'), case when p.ahi then ']' else ')' end)
         end,
         case when not p.has then true
              when not p.had then false
              when p.bu is distinct from p.au then true
              else (p.bl is not null and (p.al is null or p.al < p.bl or (p.al = p.bl and p.ali and not p.bli)))
                or (p.bh is not null and (p.ah is null or p.ah > p.bh or (p.ah = p.bh and p.ahi and not p.bhi)))
         end
  from pairs p
  where not p.has or not p.had or p.bu is distinct from p.au
     or p.bl is distinct from p.al or p.bli is distinct from p.ali or p.bh is distinct from p.ah or p.bhi is distinct from p.ahi
  union all
  select 'registration:' || coalesce(x.code, y.code),
         format('registration reference %s changed from version %s to %s', coalesce(x.code, y.code), coalesce(x.version, '(none)'), coalesce(y.version, '(none)')),
         false
  from (select r ->> 'code' as code, r ->> 'version' as version from jsonb_array_elements(coalesce(p_before -> 'references', '[]')) r
        where r ->> 'kind' = 'REGISTRATION') x
  full join (select r ->> 'code' as code, r ->> 'version' as version from jsonb_array_elements(coalesce(p_after -> 'references', '[]')) r
             where r ->> 'kind' = 'REGISTRATION') y on y.code = x.code
  where x.version is distinct from y.version
$$;

-- Content without the parts that do not affect the process: titles, the product's display name,
-- reference titles and the author-confirmed golden test data (PR-06). Everything else (batch sizes,
-- materials and quantities, equipment classes, steps and their order, block configuration and test
-- methods, parameters, limits, calculations, time constraints, risk-based reductions, references)
-- is process-impacting when it changes.
create function recipe.process_relevant(p_content jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_set(((p_content - 'goldenCases') #- '{header,title}') #- '{header,product,name}', '{references}',
                   coalesce((select jsonb_agg(r - 'title' order by o) from jsonb_array_elements(p_content -> 'references') with ordinality as t (r, o)),
                            '[]'::jsonb))
$$;

-- Process impact of a version against its baselines: top-level areas that changed. A version with no
-- baseline (the first version of a master) is a new process.
create function recipe.process_impact(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_new    jsonb := (recipe.current_content(p_version)).content;
  v_areas  text[] := '{}';
  v_base   uuid;
  v_old    jsonb;
  v_n      jsonb;
  v_o      jsonb;
  k        text;
  v_any    boolean := false;
begin
  for v_base in select * from recipe.baseline_versions(p_version) loop
    v_any := true;
    v_old := (recipe.current_content(v_base)).content;
    v_n := recipe.process_relevant(v_new);
    v_o := recipe.process_relevant(v_old);
    for k in select distinct x from (select jsonb_object_keys(v_n) x union select jsonb_object_keys(v_o)) u order by 1 loop
      if (v_n -> k) is distinct from (v_o -> k) and not (k = any (v_areas)) then
        v_areas := v_areas || k;
      end if;
    end loop;
  end loop;
  if not v_any then
    return jsonb_build_object('impacting', true, 'new_master', true, 'areas', '["new master"]'::jsonb);
  end if;
  return jsonb_build_object('impacting', cardinality(v_areas) > 0, 'new_master', false, 'areas', to_jsonb(v_areas));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards (fn(aggregate_type, aggregate_id, transition, payload, actor) returns text)
-- ---------------------------------------------------------------------------------------------

-- The signer of the transition's signature (payload.signature_id), or NULL.
create function recipe.payload_signer(p_payload jsonb) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
  select s.signer_person from esig.signature s
  where s.id::text = lower(coalesce(p_payload ->> 'signature_id', ''))
$$;

create function recipe.guard_content_present(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when not exists (select 1 from recipe.mbr_version v where v.id = p_id) then 'the MBR version does not exist'
    when recipe.content_hash_of(p_id) is null then 'the version has no content to verify (DI-04)'
  end
$$;

create function recipe.guard_validator_passed(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r record;
begin
  select * into r from recipe.current_evidence(p_id) e where e.kind = 'VALIDATOR';
  if not found then
    return 'the static validator has not been run on this exact content: run it and record the result (zero errors, every warning justified) before verification starts (outline 6.3; PR-02; DI-04)';
  end if;
  if r.result <> 'PASS' then
    return format('the static validator did not pass on this exact content: %s (outline 6.3; PR-02; DI-04)', array_to_string(r.problems, '; '));
  end if;
  return null;
end
$$;

create function recipe.guard_evidence_complete(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v jsonb := recipe.evidence_status(p_id);
begin
  if (v ->> 'complete')::boolean then
    return null;
  end if;
  return format('the verification evidence for this exact content is incomplete: missing %s (DI-04)',
                (select string_agg(x, '; ') from jsonb_array_elements_text(v -> 'missing') x));
end
$$;

create function recipe.guard_change_record_linked(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when (select v.change_record_id from recipe.mbr_version v where v.id = p_id) is null
              then 'no change record is linked to this version: every new master or change needs a change-control record (PR-06)' end
$$;

-- PR-07: every CRITICAL parameter and calculation is covered by a linked risk assessment (a link
-- for the whole master, or one that lists the element).
create function recipe.guard_critical_elements_risk_assessed(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  with content as (select (recipe.current_content(p_id)).content as c),
  critical as (
    select x ->> 'id' as id from content, jsonb_array_elements(coalesce(c -> 'parameters', '[]') || coalesce(c -> 'calculations', '[]')) x
    where x ->> 'criticality' = 'CRITICAL'),
  links as (select subjects from recipe.current_risk_links(p_id)),
  uncovered as (select k.id from critical k
                where not exists (select 1 from links l where cardinality(l.subjects) = 0 or k.id = any (l.subjects)))
  select case when exists (select 1 from uncovered)
    then format('critical elements %s have no linked risk assessment: link an approved, versioned assessment before submitting (PR-07)',
                (select string_agg(id, ', ' order by id) from uncovered)) end
$$;

create function recipe.guard_prepared_by_author(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when recipe.payload_signer(p_payload) is distinct from (select v.author_person from recipe.mbr_version v where v.id = p_id)
              then 'PREPARED is signed by the version''s author (PR-02)' end
$$;

-- The transition's signature was applied while the version was already in the transition's
-- from-state (after the preceding step), so a signature is never given ahead of its step.
create function recipe.guard_signed_in_state(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, platform, esig, pg_temp as $$
  select case when (select s.recorded_at from esig.signature s where s.id::text = lower(coalesce(p_payload ->> 'signature_id', '')))
                   < (select h.recorded_at from platform.state_history h
                      where h.aggregate_type = 'mbr_version' and h.aggregate_id = p_id and h.to_state = p_transition ->> 'from'
                      order by h.to_version desc limit 1)
              then format('the %s signature was applied before the version entered %s; it must be signed at that step (PR-02; INV-04)',
                          p_transition ->> 'event', p_transition ->> 'from') end
$$;

-- INV-04 for CHECKED: not the author; nobody who edited the content since it last entered DRAFT.
create function recipe.guard_checker_independent(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_signer uuid := recipe.payload_signer(p_payload);
  v        recipe.mbr_version;
begin
  select * into v from recipe.mbr_version where id = p_id;
  if v_signer is null then
    return 'the CHECKED signature is missing (PR-02)';
  end if;
  if v_signer = v.author_person then
    return 'the author cannot check their own MBR version: the check is independent (INV-04; PR-02)';
  end if;
  if v_signer = any (recipe.editors_since_draft(p_id)) then
    return 'the checker edited this version since it last entered DRAFT and cannot sign CHECKED (INV-04)';
  end if;
  return null;
end
$$;

-- S4 (outline 3.5, 7.2): may the checker also approve an MBR? Policy mbr.checker_may_approve in the
-- market-profile policy engine, positions ALLOWED < NOT_ALLOWED (least strict first). Without a
-- defined policy the answer is no (Decision record 0001 default; fail closed).
create function recipe.checker_may_approve() returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, market, pg_temp as $$
  select coalesce((select v.position = 'ALLOWED' from market.policy_version_at('mbr.checker_may_approve', clock_timestamp()) v), false)
$$;

-- INV-04 for APPROVED: not the author, not an editor since the last entry into DRAFT, and not the
-- checker of this cycle unless S4 allows it.
create function recipe.guard_approver_independent(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, platform, esig, pg_temp as $$
declare
  v_signer  uuid := recipe.payload_signer(p_payload);
  v_checker uuid;
  v         recipe.mbr_version;
begin
  select * into v from recipe.mbr_version where id = p_id;
  if v_signer is null then
    return 'the APPROVED signature is missing (PR-02)';
  end if;
  if v_signer = v.author_person then
    return 'the author cannot approve their own MBR version (INV-04; PR-02)';
  end if;
  if v_signer = any (recipe.editors_since_draft(p_id)) then
    return 'the approver edited this version since it last entered DRAFT and cannot sign APPROVED (INV-04)';
  end if;
  select s.signer_person into v_checker
  from platform.state_history h join esig.signature s on s.id = h.signature_id
  where h.aggregate_type = 'mbr_version' and h.aggregate_id = p_id and h.event = 'CHECK'
  order by h.to_version desc limit 1;
  if v_checker is not null and v_checker = v_signer and not recipe.checker_may_approve() then
    return 'the checker cannot also approve: author, checker and approver are three different persons unless QA policy S4 (mbr.checker_may_approve) allows it (INV-04; PR-02)';
  end if;
  return null;
end
$$;

-- PR-04 (outline 5.2.1 CHECKED -> APPROVED): the regulatory-conformity sign-off. A valid
-- REGULATORY_CONFIRMED signature on this version by a regulatory-conformity signer confirms the
-- registration references and registered details for each market of its content. A return to
-- DRAFT supersedes it like every other signature.
create function recipe.guard_regulatory_confirmed(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
  select case when not exists (select 1 from esig.signature s
                               where s.aggregate_ref = 'mbr_version:' || p_id::text and s.meaning_code = 'REGULATORY_CONFIRMED'
                                 and (esig.signature_state(s.id) ->> 'valid')::boolean)
              then 'the regulatory-conformity sign-off (REGULATORY_CONFIRMED) for the markets of this version is missing (PR-04)' end
$$;

create function recipe.guard_effective_date_set(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when (select v.effective_from from recipe.mbr_version v where v.id = p_id) is null
              then 'the version has no effective date: a master is approved with its effective date, and approval does not make it usable before that date (PR-02)' end
$$;

create function recipe.guard_review_due_set(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
  select case
    when v.review_due is null then 'the version has no periodic-review due date: every master carries one (PR-05)'
    when v.effective_from is not null and v.review_due <= (v.effective_from at time zone iam.policy_text('site.zone'))::date
      then format('the periodic-review due date %s is not after the effective date (PR-05)', v.review_due)
  end
  from recipe.mbr_version v where v.id = p_id
$$;

-- PR-06: a linked change record; a process-impacting change (as computed here, or as the change
-- owner classified it) needs a validation link on the change record.
create function recipe.guard_change_control_complete(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v        recipe.mbr_version;
  r        recipe.change_record;
  v_impact jsonb;
begin
  select * into v from recipe.mbr_version where id = p_id;
  if v.change_record_id is null then
    return 'no change record is linked to this version (PR-06)';
  end if;
  select * into r from recipe.change_record where id = v.change_record_id;
  v_impact := recipe.process_impact(p_id);
  if ((v_impact ->> 'impacting')::boolean or r.process_impacting)
     and not exists (select 1 from recipe.change_record_validation x where x.change_record_id = r.id) then
    return format('this change affects the process (%s) and change record %s has no validation link: link the validation protocol or report first (PR-06)',
                  case when (v_impact ->> 'impacting')::boolean
                       then (select string_agg(a, ', ') from jsonb_array_elements_text(v_impact -> 'areas') a)
                       else 'classified process-impacting by the change owner' end, r.number);
  end if;
  return null;
end
$$;

-- PR-04: every registered element that changed against a baseline has a regulatory assessment with
-- its reporting category for every market of the version, and a widened registered range also has
-- the variation, supplement or approval reference for that market.
create function recipe.guard_registered_ranges_kept(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v         recipe.mbr_version;
  v_new     jsonb := (recipe.current_content(p_id)).content;
  v_markets text[];
  v_base    uuid;
  x         record;
  m         text;
  v_out     text[] := '{}';
begin
  select * into v from recipe.mbr_version where id = p_id;
  v_markets := array(select jsonb_array_elements_text(v_new -> 'header' -> 'marketSet'));
  for v_base in select * from recipe.baseline_versions(p_id) loop
    for x in select * from recipe.registered_changes((recipe.current_content(v_base)).content, v_new) loop
      foreach m in array v_markets loop
        if not exists (select 1 from recipe.change_record_regulatory g where g.change_record_id = v.change_record_id and g.market = m
                         and (not x.widened or btrim(coalesce(g.regulatory_reference, '')) <> '')) then
          v_out := v_out || format('%s: %s without %s for market %s', x.subject, x.change,
                                   case when x.widened then 'a variation, supplement or approval reference' else 'a regulatory assessment' end, m);
        end if;
      end loop;
    end loop;
  end loop;
  if cardinality(v_out) > 0 then
    return format('registered elements changed without the regulatory action each market needs: %s (PR-04)',
                  array_to_string(array(select distinct e from unnest(v_out) e order by 1), '; '));
  end if;
  return null;
end
$$;

-- ADR 0014 item 7 (L-24): every issued or running batch of an earlier version of the family has an
-- in-flight disposition for this version (tables in 0150; the function body is bound at run time).
create function recipe.guard_in_flight_dispositioned(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_missing text;
begin
  select string_agg(b.batch_number, ', ' order by b.batch_number) into v_missing
  from recipe.mbr_version v
  join recipe.mbr_version pv on pv.family_id = v.family_id and pv.version_number < v.version_number
  join recipe.batch_mbr_pin p on p.version_id = pv.id
  join recipe.stub_batch b on b.id = p.batch_id
  where v.id = p_id and b.status in ('ISSUED', 'IN_PROGRESS')
    and not exists (select 1 from recipe.in_flight_disposition d where d.successor_version_id = v.id and d.batch_id = b.id);
  if v_missing is not null then
    return format('batches %s of an earlier version are issued or running without an in-flight disposition for this version (CONTINUE, HOLD_FOR_ASSESSMENT or CANCEL_UNSTARTED) (ADR 0014; PR-05)', v_missing);
  end if;
  return null;
end
$$;

create function recipe.guard_draft_entry_recorded(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql volatile set search_path = pg_catalog, recipe, pg_temp as $$
  select case when not exists (select 1 from recipe.mbr_draft_entry d
                               where d.version_id = p_id and d.xact_id = txid_current() and d.from_state = p_transition ->> 'from')
              then 'a return to DRAFT goes through recipe.return_to_draft, which records the new draft cycle so every signature on the version is superseded (DI-37; INV-09)' end
$$;

-- Authorisation cells are created in 0160; these guards are bound at run time.
create function recipe.guard_never_authorised(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if exists (select 1 from recipe.authorisation_cell c where c.version_id = p_id) then
    return 'the version has been authorised for a market: retire it instead of withdrawing it (ADR 0014; PR-05)';
  end if;
  return null;
end
$$;

create function recipe.guard_no_open_authorisation(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if exists (select 1 from recipe.authorisation_cell c where c.version_id = p_id and c.status in ('CURRENT', 'BRIDGING')) then
    return 'the version is still CURRENT or BRIDGING for a market: retire it through recipe.retire_version, which ends those authorisations in the same command (PR-05)';
  end if;
  return null;
end
$$;

select platform.register_guard('mbr_version.content_present', 'recipe.guard_content_present(text, uuid, jsonb, jsonb, jsonb)',
  'The MBR version exists and has content');
select platform.register_guard('mbr_version.validator_passed', 'recipe.guard_validator_passed(text, uuid, jsonb, jsonb, jsonb)',
  'A passing static-validator result is recorded for the exact current content hash (outline 6.3; PR-02; DI-04)');
select platform.register_guard('mbr_version.evidence_complete', 'recipe.guard_evidence_complete(text, uuid, jsonb, jsonb, jsonb)',
  'Verification evidence (validator, simulation, confirmed test vectors, sandbox run or delta verification) is complete for the exact content hash (DI-04)');
select platform.register_guard('mbr_version.change_record_linked', 'recipe.guard_change_record_linked(text, uuid, jsonb, jsonb, jsonb)',
  'A change record is linked (PR-06)');
select platform.register_guard('mbr_version.critical_elements_risk_assessed', 'recipe.guard_critical_elements_risk_assessed(text, uuid, jsonb, jsonb, jsonb)',
  'Every critical parameter and calculation is covered by a linked risk assessment (PR-07)');
select platform.register_guard('mbr_version.prepared_by_author', 'recipe.guard_prepared_by_author(text, uuid, jsonb, jsonb, jsonb)',
  'PREPARED is signed by the version author (PR-02)');
select platform.register_guard('mbr_version.signed_in_state', 'recipe.guard_signed_in_state(text, uuid, jsonb, jsonb, jsonb)',
  'The signature was applied after the version entered the transition''s from-state (PR-02; INV-04)');
select platform.register_guard('mbr_version.checker_independent', 'recipe.guard_checker_independent(text, uuid, jsonb, jsonb, jsonb)',
  'The checker is not the author and did not edit the content since it last entered DRAFT (INV-04)');
select platform.register_guard('mbr_version.approver_independent', 'recipe.guard_approver_independent(text, uuid, jsonb, jsonb, jsonb)',
  'The approver is not the author, not an editor since the last entry into DRAFT, and not the checker unless S4 allows (INV-04)');
select platform.register_guard('mbr_version.regulatory_confirmed', 'recipe.guard_regulatory_confirmed(text, uuid, jsonb, jsonb, jsonb)',
  'A valid regulatory-conformity sign-off (REGULATORY_CONFIRMED) of the version exists (PR-04)');
select platform.register_guard('mbr_version.effective_date_set', 'recipe.guard_effective_date_set(text, uuid, jsonb, jsonb, jsonb)',
  'The effective date is set (PR-02)');
select platform.register_guard('mbr_version.review_due_set', 'recipe.guard_review_due_set(text, uuid, jsonb, jsonb, jsonb)',
  'The periodic-review due date is set and after the effective date (PR-05)');
select platform.register_guard('mbr_version.change_control_complete', 'recipe.guard_change_control_complete(text, uuid, jsonb, jsonb, jsonb)',
  'A change record is linked and a process-impacting change has a validation link (PR-06)');
select platform.register_guard('mbr_version.registered_ranges_kept', 'recipe.guard_registered_ranges_kept(text, uuid, jsonb, jsonb, jsonb)',
  'Changed registered elements have a regulatory assessment per market; widened registered ranges a variation reference (PR-04)');
select platform.register_guard('mbr_version.in_flight_dispositioned', 'recipe.guard_in_flight_dispositioned(text, uuid, jsonb, jsonb, jsonb)',
  'Every issued or running batch of an earlier version has an in-flight disposition (ADR 0014; L-24)');
select platform.register_guard('mbr_version.draft_entry_recorded', 'recipe.guard_draft_entry_recorded(text, uuid, jsonb, jsonb, jsonb)',
  'The return to DRAFT recorded a new draft cycle in this transaction, superseding every signature (DI-37; INV-09)');
select platform.register_guard('mbr_version.never_authorised', 'recipe.guard_never_authorised(text, uuid, jsonb, jsonb, jsonb)',
  'The version was never authorised for any market (ADR 0014)');
select platform.register_guard('mbr_version.no_open_authorisation', 'recipe.guard_no_open_authorisation(text, uuid, jsonb, jsonb, jsonb)',
  'No market authorisation of the version is still CURRENT or BRIDGING (PR-05)');

grant execute on function recipe.baseline_versions(uuid), recipe.registered_ranges(jsonb), recipe.registered_changes(jsonb, jsonb),
                          recipe.process_relevant(jsonb), recipe.process_impact(uuid), recipe.checker_may_approve() to ebmr_app;
-- The content provider, payload_signer and the guard functions stay private to the owner.

reset role;
