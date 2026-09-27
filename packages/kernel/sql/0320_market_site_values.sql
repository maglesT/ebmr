-- Market-profile engine, part 3: site values (build outline 3.3.2; ADR 0008 decision 8).
--
-- A site may set its own value for a rule key, and it may only tighten:
--   * a value looser than a HARD value (or the hard floor under a non-HARD value) is refused;
--   * a value looser than a DESIGN value (our product choice) is refused: design choices change
--     only through a new table version or the vendor profile, never per site;
--   * loosening a GUIDANCE or adopted EXAMPLE value needs a justification reference (the
--     contamination-control-strategy reference for sterile keys) and a QA approval record, and it
--     is flagged on every evaluation that uses it (market.batch_flags, 0330).
-- Set-valued keys (SET_UNION, ALL_APPLY) accept only supersets. NOT_COMPARABLE keys take no site
-- value. Source corrections of shipped values are not site values: they are a separate path with a
-- citation, two approvers and a new table version (market.publish_rule_table, 0340).

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
  recorded_at        timestamptz not null default clock_timestamp(),
  recorded_by        uuid not null,
  check (outcome <> 'LOOSENED' or (coalesce(length(trim(justification_ref)), 0) > 0 and qa_approval_id is not null))
);
create index site_value_lookup on market.site_value (site_id, key, effective_from);
comment on table market.site_value is 'Site-specific values for rule keys. Insert-only; the newest row effective on a date is in force.';

-- Assess a candidate value against a resolution. Returns {outcome, code, message}: outcome is
-- TIGHTER, EQUAL, LOOSENING (allowed only with justification and QA approval) or REFUSED.
create function market.assess_site_value(p_resolution jsonb, p_value jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market as $$
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
      'message', format('a site value for %s may add elements but cannot remove any of %s', k.key, v_res::text));
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

-- The site value in force for a site, key and date (newest effective, then newest recorded).
create function market.site_value_in_force(p_site uuid, p_key text, p_as_of date) returns market.site_value
language sql stable security definer set search_path = pg_catalog, market as $$
  select sv.* from market.site_value sv
  where sv.site_id = p_site and sv.key = p_key and sv.effective_from <= p_as_of
  order by sv.effective_from desc, sv.recorded_at desc, sv.id
  limit 1
$$;

-- Apply the site value in force to a resolution. The site value is re-assessed against this
-- resolution (this batch's markets and today's table), so a value that was admissible when it was
-- set but has since become too loose is not applied; it is flagged instead.
-- Returns {siteValueId, outcome, effectiveValue}; outcome is NO_SITE_VALUE, SITE_TIGHTER,
-- SITE_EQUAL, SITE_LOOSENED or SITE_VALUE_INADMISSIBLE.
create function market.apply_site_value(p_resolution jsonb, p_site uuid, p_as_of date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market as $$
declare
  sv  market.site_value;
  a   jsonb;
begin
  if p_site is null or p_resolution ->> 'method' = 'NOT_COMPARABLE' then
    return jsonb_build_object('siteValueId', null, 'outcome', 'NO_SITE_VALUE', 'effectiveValue', p_resolution -> 'value');
  end if;
  sv := market.site_value_in_force(p_site, p_resolution ->> 'key', p_as_of);
  if sv.id is null then
    return jsonb_build_object('siteValueId', null, 'outcome', 'NO_SITE_VALUE', 'effectiveValue', p_resolution -> 'value');
  end if;
  a := market.assess_site_value(p_resolution, sv.value);
  return jsonb_build_object('siteValueId', sv.id,
    'outcome', case a ->> 'outcome'
                 when 'TIGHTER' then 'SITE_TIGHTER'
                 when 'EQUAL' then 'SITE_EQUAL'
                 when 'LOOSENING' then case when sv.outcome = 'LOOSENED' then 'SITE_LOOSENED' else 'SITE_VALUE_INADMISSIBLE' end
                 else 'SITE_VALUE_INADMISSIBLE' end,
    'effectiveValue', case
                        when a ->> 'outcome' in ('TIGHTER', 'EQUAL') then sv.value
                        when a ->> 'outcome' = 'LOOSENING' and sv.outcome = 'LOOSENED' then sv.value
                        else p_resolution -> 'value' end);
end
$$;

-- Set a site value. p_options: {justificationRef, qaApprovalId, tableVersionId, predicates}.
create function market.set_site_value(p_site uuid, p_key text, p_value jsonb, p_effective_from date, p_options jsonb default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel as $$
declare
  v_ctx      jsonb := kernel.current_actor();
  v_table    text := market.table_of_key(p_key);
  v_version  uuid;
  v_scope    jsonb;
  v_pred     jsonb;
  v_res      jsonb;
  a          jsonb;
  v_outcome  text;
  sv         market.site_value;
  v_opt      jsonb := coalesce(p_options, '{}'::jsonb);
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
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
  v_res := market.resolve(v_version, p_key, array(select jsonb_array_elements_text(v_scope -> 'markets')), v_pred, p_effective_from);
  a := market.assess_site_value(v_res, p_value);
  if a ->> 'outcome' = 'REFUSED' then
    raise exception using errcode = 'P0001', message = (a ->> 'code') || ' ' || (a ->> 'message');
  end if;
  v_outcome := a ->> 'outcome';
  if v_outcome = 'LOOSENING' then
    if coalesce(trim(v_opt ->> 'justificationRef'), '') = '' or (v_opt ->> 'qaApprovalId') is null then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-065 site value %s for %s loosens a %s value %s; it needs a justification (CCS) reference and a QA approval record',
        p_value::text, p_key, v_res ->> 'floorType', (v_res -> 'value')::text);
    end if;
    v_outcome := 'LOOSENED';
  end if;
  insert into market.site_value (site_id, key, value, unit, effective_from, table_version_id, market_set, predicates, resolution,
                                 outcome, justification_ref, qa_approval_id, recorded_by)
  values (p_site, p_key, p_value, v_res ->> 'unit', p_effective_from, v_version,
          array(select jsonb_array_elements_text(v_scope -> 'markets')), v_pred, v_res, v_outcome,
          nullif(trim(v_opt ->> 'justificationRef'), ''), (v_opt ->> 'qaApprovalId')::uuid, (v_ctx ->> 'person_id')::uuid)
  returning * into sv;
  if v_outcome = 'LOOSENED' then
    perform kernel.audit_business_event('site_value:' || p_site::text,
      format('site value for %s loosens a %s value from %s to %s under %s', p_key, v_res ->> 'floorType', (v_res -> 'value')::text, p_value::text, sv.justification_ref),
      jsonb_build_object('siteValueId', sv.id, 'qaApprovalId', sv.qa_approval_id));
  end if;
  return to_jsonb(sv);
end
$$;

select kernel.register_audited_table('market.site_value', 'site_value', 'site_id', true);

grant select on market.site_value to ebmr_app;
grant execute on function market.set_site_value(uuid, text, jsonb, date, jsonb), market.assess_site_value(jsonb, jsonb),
                          market.apply_site_value(jsonb, uuid, date) to ebmr_app;

reset role;
