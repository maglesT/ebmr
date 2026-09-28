-- Market-profile engine, part 3: site values (build outline 3.3.2; ADR 0008 decision 8).
--
-- A site may set its own value for a rule key, and it may only tighten:
--   * a value looser than a HARD value (or the hard floor under a non-HARD value) is refused;
--   * a value looser than a DESIGN value (our product choice) is refused: design choices change
--     only through a new table version or the vendor profile, never per site;
--   * loosening a GUIDANCE or adopted EXAMPLE value needs a justification reference (the
--     contamination-control-strategy reference for sterile keys) and the QA approval: an electronic
--     signature SITE_VALUE_LOOSENING_APPROVED (0360) of exactly that loosening (site, key, effective
--     date, the value it departs from, the new value and the justification), signed by a person other
--     than the one who sets the value. It is flagged on every evaluation that uses it
--     (market.batch_flags, 0330);
--   * an approved loosening covers only the departure it was approved for: an evaluation whose
--     resolution differs (another value, floor type, binding floor, governing market or predicate
--     branch, for example after a new table version tightened the value) does not apply it and flags
--     it SITE_VALUE_INADMISSIBLE, and a new table version that changes it lists it on the change-impact
--     list (0340).
-- Set-valued keys (SET_UNION, ALL_APPLY) accept only supersets. NOT_COMPARABLE keys take no site
-- value. Source corrections of shipped values are not site values: they are a separate path with a
-- citation, two QA signatures and a new table version (market.publish_rule_table, 0340).

set local role ebmr_owner;

create table market.site_value (
  id                 uuid primary key default gen_random_uuid(),
  site_id            uuid not null,
  key                text not null,
  value              jsonb not null,
  unit               text not null,
  effective_from     date not null,
  table_version_id   uuid not null references market.rule_table_version (id),
  market_set         text[] not null check ('IN' = any(market_set)),
  predicates         jsonb not null,
  resolution         jsonb not null,
  outcome            text not null check (outcome in ('TIGHTER', 'EQUAL', 'LOOSENED')),
  justification_ref  text,
  qa_approval_id     uuid,
  qa_approver_id     uuid,
  recorded_at        timestamptz not null default clock_timestamp(),
  recorded_by        uuid not null,
  check (outcome <> 'LOOSENED' or (coalesce(length(trim(justification_ref)), 0) > 0 and qa_approval_id is not null and qa_approver_id is not null)),
  check (outcome = 'LOOSENED' or (qa_approval_id is null and qa_approver_id is null))
);
create index site_value_lookup on market.site_value (site_id, key, effective_from);
comment on table market.site_value is 'Site-specific values for rule keys. Insert-only; the newest row effective on a date is in force.';
comment on column market.site_value.qa_approval_id is 'LOOSENED only: the SITE_VALUE_LOOSENING_APPROVED e-signature of this loosening (esig.signature id).';
comment on column market.site_value.qa_approver_id is 'LOOSENED only: the person who signed the QA approval (never recorded_by).';
comment on column market.site_value.resolution is 'The resolution the value was assessed against; a LOOSENED value applies only where the loosening basis is the same.';

-- Assess a candidate value against a resolution. Returns {outcome, code, message}: outcome is
-- TIGHTER, EQUAL, LOOSENING (allowed only with justification and QA approval) or REFUSED.
create function market.assess_site_value(p_resolution jsonb, p_value jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  k         market.rule_key;
  v_prob    text;
  v_res     jsonb := p_resolution -> 'value';
  c         jsonb;
  v_design  text;
begin
  select * into k from market.rule_key where version_id = (p_resolution ->> 'tableVersionId')::uuid and key = p_resolution ->> 'key';
  if k.method = 'NOT_COMPARABLE' then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-063',
      'message', format('key %s is NOT_COMPARABLE; it is resolved per destination and takes no site value', k.key));
  end if;
  v_prob := market.value_problem(k.value_type, k.ordered_values, p_value);
  if v_prob is not null then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-062', 'message', format('site value for %s: %s', k.key, v_prob));
  end if;
  if not (p_resolution ->> 'applicable')::boolean then
    -- No market in scope sets this key, so any site value is an addition.
    return jsonb_build_object('outcome', 'TIGHTER');
  end if;
  if market.at_least_as_strict(k.method, k.ordered_values, p_value, v_res) then
    return jsonb_build_object('outcome', case when p_value = v_res then 'EQUAL' else 'TIGHTER' end);
  end if;
  if k.method in ('SET_UNION', 'ALL_APPLY') then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-064',
      'message', format('a site value for %s may add elements but cannot remove or change any of %s', k.key, v_res::text));
  end if;
  if market.nz(p_resolution -> 'hardFloor', null) is not null
     and not market.at_least_as_strict(k.method, k.ordered_values, p_value, p_resolution -> 'hardFloor') then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-060',
      'message', format('site value %s for %s is looser than the binding (HARD) value %s', p_value::text, k.key, (p_resolution -> 'hardFloor')::text));
  end if;
  select string_agg(x ->> 'market', ', ' order by x ->> 'market') into v_design
    from jsonb_array_elements(p_resolution -> 'contributions') x
   where x ->> 'floorType' = 'DESIGN' and not market.at_least_as_strict(k.method, k.ordered_values, p_value, x -> 'value');
  if v_design is not null then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-061',
      'message', format('site value %s for %s would loosen a DESIGN value (product choice, %s); design values change only through a new table version',
                        p_value::text, k.key, v_design));
  end if;
  return jsonb_build_object('outcome', 'LOOSENING');
end
$$;

-- What a loosening departs from: the resolved value with its floor type, binding floor, governing
-- markets and their predicate branches. An approval covers one basis; a resolution with any other
-- basis asks for a different loosening, which needs its own approval.
create function market.loosening_basis(p_resolution jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, market, pg_temp as $$
  select jsonb_build_object(
    'value', market.nz(p_resolution -> 'value', 'null'),
    'floorType', market.nz(p_resolution -> 'floorType', 'null'),
    'hardFloor', market.nz(p_resolution -> 'hardFloor', 'null'),
    'governingMarkets', coalesce(p_resolution -> 'governingMarkets', '[]'::jsonb),
    'predicateBranch', coalesce((select jsonb_object_agg(m, p_resolution -> 'predicateBranch' -> m)
                                   from jsonb_array_elements_text(coalesce(p_resolution -> 'governingMarkets', '[]'::jsonb)) m), '{}'::jsonb))
$$;

-- The aggregate a QA approval of a site-value loosening signs (content provider in 0360):
--   <site id>@<key>@<effective from>@<value departed from>@<new value>@<justification reference>
-- with the values as JSON text. Only scalar values (decimals, categories, booleans) can be loosened.
create function market.site_loosening_ref(p_site uuid, p_key text, p_effective_from date, p_from jsonb, p_to jsonb, p_justification text)
returns text
language sql stable set search_path = pg_catalog, pg_temp as $$
  select p_site::text || '@' || p_key || '@' || to_char(p_effective_from, 'YYYY-MM-DD') || '@' || p_from::text || '@' || p_to::text
         || '@' || trim(p_justification)
$$;

-- The site value in force for a site, key and date (newest effective, then newest recorded).
create function market.site_value_in_force(p_site uuid, p_key text, p_as_of date) returns market.site_value
language sql stable security definer set search_path = pg_catalog, market, pg_temp as $$
  select sv.* from market.site_value sv
  where sv.site_id = p_site and sv.key = p_key and sv.effective_from <= p_as_of
  order by sv.effective_from desc, sv.recorded_at desc, sv.id
  limit 1
$$;

-- Apply the site value in force to a resolution. The site value is re-assessed against this
-- resolution (this batch's markets and today's table), so a value that was admissible when it was
-- set but has since become too loose is not applied; it is flagged instead. An approved loosening
-- is applied only where it departs from the same basis it was approved against (F25): after a new
-- table version tightened the value, or for a batch whose markets or branch give another value, it
-- is a loosening nobody approved.
-- Returns {siteValueId, outcome, effectiveValue}; outcome is NO_SITE_VALUE, SITE_TIGHTER,
-- SITE_EQUAL, SITE_LOOSENED or SITE_VALUE_INADMISSIBLE.
create function market.apply_site_value(p_resolution jsonb, p_site uuid, p_as_of date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  sv          market.site_value;
  a           jsonb;
  v_approved  boolean;
begin
  if p_site is null or p_resolution ->> 'method' = 'NOT_COMPARABLE' then
    return jsonb_build_object('siteValueId', null, 'outcome', 'NO_SITE_VALUE', 'effectiveValue', p_resolution -> 'value');
  end if;
  sv := market.site_value_in_force(p_site, p_resolution ->> 'key', p_as_of);
  if sv.id is null then
    return jsonb_build_object('siteValueId', null, 'outcome', 'NO_SITE_VALUE', 'effectiveValue', p_resolution -> 'value');
  end if;
  a := market.assess_site_value(p_resolution, sv.value);
  v_approved := a ->> 'outcome' = 'LOOSENING' and sv.outcome = 'LOOSENED'
                and market.loosening_basis(p_resolution) = market.loosening_basis(sv.resolution);
  return jsonb_build_object('siteValueId', sv.id,
    'outcome', case a ->> 'outcome'
                 when 'TIGHTER' then 'SITE_TIGHTER'
                 when 'EQUAL' then 'SITE_EQUAL'
                 when 'LOOSENING' then case when v_approved then 'SITE_LOOSENED' else 'SITE_VALUE_INADMISSIBLE' end
                 else 'SITE_VALUE_INADMISSIBLE' end,
    'effectiveValue', case
                        when a ->> 'outcome' in ('TIGHTER', 'EQUAL') then sv.value
                        when v_approved then sv.value
                        else p_resolution -> 'value' end);
end
$$;

-- The resolution a site value is assessed against: the site's markets and predicates (plus
-- p_options.predicates), rule-table version p_options.tableVersionId or the current one, on the
-- effective-from date. Returns {tableVersionId, markets, predicates, resolution}.
create function market.site_value_basis(p_site uuid, p_key text, p_effective_from date, p_options jsonb)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v_table    text := market.table_of_key(p_key);
  v_opt      jsonb := coalesce(p_options, '{}'::jsonb);
  v_version  uuid;
  v_scope    jsonb;
  v_pred     jsonb;
begin
  if v_table is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-041 key %s belongs to no rule table', p_key);
  end if;
  if p_effective_from is null then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-002 a site value needs an effective-from date';
  end if;
  v_version := coalesce((v_opt ->> 'tableVersionId')::uuid, market.current_version(v_table));
  if v_version is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-040 rule table %s has no published version', v_table);
  end if;
  if exists (select 1 from market.rule_key rk where rk.version_id = v_version and rk.key = p_key and rk.method = 'NOT_COMPARABLE') then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-063 key %s is NOT_COMPARABLE; it is resolved per destination and takes no site value', p_key);
  end if;
  v_scope := market.scope_markets('SITE', p_site, v_table);
  v_pred := (v_scope -> 'predicates') || coalesce(v_opt -> 'predicates', '{}'::jsonb);
  return jsonb_build_object('tableVersionId', v_version, 'markets', v_scope -> 'markets', 'predicates', v_pred,
    'resolution', market.resolve(v_version, p_key, array(select jsonb_array_elements_text(v_scope -> 'markets')), v_pred, p_effective_from));
end
$$;

-- What market.set_site_value would decide for a candidate value, without writing anything:
-- {outcome, code?, message?, resolution, approval}. For a loosening with a justification reference,
-- approval names what the QA approver signs: {meaning, aggregateType, aggregateId}.
create function market.site_value_preview(p_site uuid, p_key text, p_value jsonb, p_effective_from date, p_options jsonb default '{}')
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v_basis  jsonb := market.site_value_basis(p_site, p_key, p_effective_from, p_options);
  a        jsonb := market.assess_site_value(v_basis -> 'resolution', p_value);
  v_just   text := nullif(trim(coalesce(p_options, '{}'::jsonb) ->> 'justificationRef'), '');
begin
  return a || jsonb_build_object('resolution', v_basis -> 'resolution',
    'approval', case when a ->> 'outcome' = 'LOOSENING' and v_just is not null then
                  jsonb_build_object('meaning', 'SITE_VALUE_LOOSENING_APPROVED', 'aggregateType', 'market_site_loosening',
                                     'aggregateId', market.site_loosening_ref(p_site, p_key, p_effective_from, v_basis -> 'resolution' -> 'value',
                                                                              p_value, v_just)) end);
end
$$;

-- Set a site value. p_options: {justificationRef, qaApprovalId, tableVersionId, predicates}.
-- qaApprovalId is the id of the SITE_VALUE_LOOSENING_APPROVED e-signature of this loosening
-- (market.site_value_preview names the aggregate to sign); it is needed and read only for a loosening.
create function market.set_site_value(p_site uuid, p_key text, p_value jsonb, p_effective_from date, p_options jsonb default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_ctx       jsonb := kernel.current_actor();
  v_basis     jsonb;
  v_res       jsonb;
  a           jsonb;
  v_outcome   text;
  v_just      text;
  v_approval  uuid;
  v_approver  uuid;
  sv          market.site_value;
  v_opt       jsonb := coalesce(p_options, '{}'::jsonb);
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  -- DI-18, then DI-17 in the site's scope (Phase 1: the stub site's code).
  perform iam.assert_not_administrator();
  perform iam.require_permission('MARKET.SITE_VALUE_SET',
                                 jsonb_strip_nulls(jsonb_build_object('site', (select s.code from market.stub_site s where s.id = p_site))));
  v_basis := market.site_value_basis(p_site, p_key, p_effective_from, v_opt);
  v_res := v_basis -> 'resolution';
  a := market.assess_site_value(v_res, p_value);
  if a ->> 'outcome' = 'REFUSED' then
    raise exception using errcode = 'P0001', message = (a ->> 'code') || ' ' || (a ->> 'message');
  end if;
  v_outcome := a ->> 'outcome';
  v_just := nullif(trim(v_opt ->> 'justificationRef'), '');
  if v_outcome = 'LOOSENING' then
    v_approval := market.try_uuid(v_opt ->> 'qaApprovalId');
    if v_just is null or v_approval is null then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-065 site value %s for %s loosens a %s value %s; it needs a justification (CCS) reference and a QA approval record',
        p_value::text, p_key, v_res ->> 'floorType', (v_res -> 'value')::text);
    end if;
    -- The QA approval is an e-signature of exactly this loosening (EBMR-ESIG-070 otherwise), made by
    -- someone other than the person who sets the value.
    v_approver := (esig.assert_signature(v_approval, 'SITE_VALUE_LOOSENING_APPROVED', 'market_site_loosening',
                     market.site_loosening_ref(p_site, p_key, p_effective_from, v_res -> 'value', p_value, v_just)) ->> 'signer_person')::uuid;
    if v_approver = (v_ctx ->> 'person_id')::uuid then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-066 the QA approval of the loosening of %s is signed by the person who sets the value; another person approves it', p_key);
    end if;
    v_outcome := 'LOOSENED';
  end if;
  insert into market.site_value (site_id, key, value, unit, effective_from, table_version_id, market_set, predicates, resolution,
                                 outcome, justification_ref, qa_approval_id, qa_approver_id, recorded_by)
  values (p_site, p_key, p_value, v_res ->> 'unit', p_effective_from, (v_basis ->> 'tableVersionId')::uuid,
          array(select jsonb_array_elements_text(v_basis -> 'markets')), v_basis -> 'predicates', v_res, v_outcome,
          v_just, v_approval, v_approver, (v_ctx ->> 'person_id')::uuid)
  returning * into sv;
  if v_outcome = 'LOOSENED' then
    perform kernel.audit_business_event('market_site_value:' || p_site::text,
      format('site value for %s loosens a %s value from %s to %s under %s', p_key, v_res ->> 'floorType', (v_res -> 'value')::text, p_value::text, sv.justification_ref),
      jsonb_build_object('siteValueId', sv.id, 'qaApprovalId', sv.qa_approval_id));
  end if;
  return to_jsonb(sv);
end
$$;

select kernel.register_audited_table('market.site_value', 'market_site_value', 'site_id', true);

grant select on market.site_value to ebmr_app;
grant execute on function market.set_site_value(uuid, text, jsonb, date, jsonb), market.assess_site_value(jsonb, jsonb),
                          market.apply_site_value(jsonb, uuid, date), market.site_value_preview(uuid, text, jsonb, date, jsonb),
                          market.loosening_basis(jsonb) to ebmr_app;

reset role;
