-- Market-profile engine, part 4: stored evaluations (build outline 3.3.2 "stored at every
-- resolution point"; ADR 0008 decision 7; control IN-52; invariants INV-28, INV-29).
--
-- Every resolution a GMP decision uses is stored: resolved value, governing market(s), predicate
-- branch, rule-table version, the inputs and their hash, and how a site value was applied. The table
-- is insert-only and audited. The application role has no write privilege on it at all.
--
-- A BEFORE INSERT trigger recomputes the resolution from the stored inputs with market.resolve and
-- refuses a row whose supplied result differs, so not even the table owner can store a value the
-- rule table does not give (INV-29), and a set without India or a result looser than India's value
-- cannot be stored (INV-28).

set local role ebmr_owner;

create table market.evaluation (
  id                  uuid primary key default gen_random_uuid(),
  recorded_at         timestamptz not null default clock_timestamp(),
  subject_type        text not null check (subject_type ~ '^[A-Z][A-Z_]*$'),
  subject_id          uuid not null,
  resolution_point    text not null check (resolution_point in ('MBR_APPROVAL', 'BATCH_ISSUE', 'EXECUTION', 'CONSUMPTION', 'RELEASE',
                                                               'SAMPLE_RETENTION', 'ARCHIVING', 'MARKET_SET_CHANGE', 'LINE_QUALIFICATION',
                                                               'QA_RE_RESOLUTION')),
  scope_kind          text not null check (scope_kind in ('PRODUCT', 'PACK', 'SITE', 'LINE', 'ROOM', 'EQUIPMENT', 'PERSON', 'MATERIAL_LOT')),
  scope_id            uuid not null,
  consuming_batch_id  uuid,
  site_id             uuid,
  key                 text not null,
  table_code          text not null,
  table_version_id    uuid not null references market.rule_table_version (id),
  table_version       integer not null,
  as_of               date not null,
  market_set          text[] not null check ('IN' = any(market_set)),
  market_derivation   jsonb not null,
  predicates          jsonb not null,
  stated              jsonb,
  method              text not null,
  unit                text not null,
  applicable          boolean not null,
  resolved_value      jsonb,
  governing_markets   text[] not null,
  predicate_branch    jsonb not null,
  floor_type          text,
  hard_floor          jsonb,
  site_value_id       uuid references market.site_value (id),
  site_outcome        text not null check (site_outcome in ('NO_SITE_VALUE', 'SITE_TIGHTER', 'SITE_EQUAL', 'SITE_LOOSENED', 'SITE_VALUE_INADMISSIBLE')),
  effective_value     jsonb,
  resolution          jsonb not null,
  inputs              jsonb not null,
  inputs_hash         bytea not null check (length(inputs_hash) = 32),
  actor_person_id     uuid not null,
  correlation_id      uuid not null,
  check (not applicable or resolved_value is not null),
  check (scope_kind <> 'MATERIAL_LOT' or consuming_batch_id is not null)
);
create index evaluation_subject on market.evaluation (subject_id, key);
comment on table market.evaluation is 'Every stored rule resolution (INV-29). Insert-only; written only through market.record_evaluation.';

create function market.evaluation_complete() returns trigger
language plpgsql security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_ctx   jsonb := kernel.current_actor();
  v_res   jsonb;
  v_site  jsonb;
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  v_res := market.resolve(new.table_version_id, new.key, new.market_set, new.predicates, new.as_of, new.stated);
  if new.resolution is not null and new.resolution <> v_res then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-053 the evaluation of %s does not match rule table %s version %s for its inputs; it cannot be stored (INV-29)',
      new.key, v_res ->> 'tableCode', v_res ->> 'tableVersion');
  end if;
  v_site := market.apply_site_value(v_res, new.site_id, new.as_of);
  if new.effective_value is not null and new.effective_value <> v_site -> 'effectiveValue' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-053 the effective value of %s does not match the site value in force; it cannot be stored (INV-29)', new.key);
  end if;
  new.recorded_at := clock_timestamp();
  new.resolution := v_res;
  new.market_set := array(select jsonb_array_elements_text(v_res -> 'inputs' -> 'marketSet'));
  new.predicates := v_res -> 'inputs' -> 'predicates';
  new.table_code := v_res ->> 'tableCode';
  new.table_version := (v_res ->> 'tableVersion')::integer;
  new.method := v_res ->> 'method';
  new.unit := v_res ->> 'unit';
  new.applicable := (v_res ->> 'applicable')::boolean;
  new.resolved_value := market.nz(v_res -> 'value', null);
  new.governing_markets := array(select jsonb_array_elements_text(v_res -> 'governingMarkets'));
  new.predicate_branch := v_res -> 'predicateBranch';
  new.floor_type := v_res ->> 'floorType';
  new.hard_floor := market.nz(v_res -> 'hardFloor', null);
  new.site_value_id := (v_site ->> 'siteValueId')::uuid;
  new.site_outcome := v_site ->> 'outcome';
  new.effective_value := market.nz(v_site -> 'effectiveValue', null);
  new.inputs := (v_res -> 'inputs') || jsonb_build_object(
    'scopeKind', new.scope_kind, 'scopeId', new.scope_id, 'consumingBatchId', new.consuming_batch_id, 'siteId', new.site_id,
    'resolutionPoint', new.resolution_point, 'marketDerivation', new.market_derivation);
  new.inputs_hash := sha256(convert_to(new.inputs::text, 'UTF8'));
  new.actor_person_id := (v_ctx ->> 'person_id')::uuid;
  new.correlation_id := (v_ctx ->> 'correlation_id')::uuid;
  return new;
end
$$;

create trigger a_complete before insert on market.evaluation for each row execute function market.evaluation_complete();

-- The one writer. p_req: {key, tableVersionId?, scope: {kind, id}, consumingBatchId?, subject: {type, id}?,
-- resolutionPoint, asOf, markets, marketDerivation, predicates, stated?, siteId?}.
-- Internal: editions call it from their own SECURITY DEFINER functions, which derive the market set
-- from their tables; the application calls market.evaluate_stub_scope in Phase 1.
create function market.record_evaluation(p_req jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_key      text := p_req ->> 'key';
  v_table    text := market.table_of_key(p_req ->> 'key');
  v_version  uuid;
  v_as_of    date := market.parse_date(p_req ->> 'asOf');
  e          market.evaluation;
begin
  if v_table is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-041 key %s belongs to no rule table', coalesce(v_key, '(missing)'));
  end if;
  if v_as_of is null then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-002 a resolution needs an as-of date written YYYY-MM-DD';
  end if;
  v_version := coalesce((p_req ->> 'tableVersionId')::uuid, market.current_version(v_table));
  if v_version is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-040 rule table %s has no published version', v_table);
  end if;
  if not exists (select 1 from market.rule_table_version v where v.id = v_version and v.table_code = v_table) then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-040 version %s is not a version of rule table %s', v_version, v_table);
  end if;
  if jsonb_typeof(p_req -> 'markets') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-001 a market set is required';
  end if;
  -- Only the inputs are supplied; market.evaluation_complete computes and fills every result column.
  insert into market.evaluation (subject_type, subject_id, resolution_point, scope_kind, scope_id, consuming_batch_id, site_id, key,
                                 table_version_id, as_of, market_set, market_derivation, predicates, stated)
  values (coalesce(p_req -> 'subject' ->> 'type', case p_req -> 'scope' ->> 'kind' when 'PRODUCT' then 'BATCH' else p_req -> 'scope' ->> 'kind' end),
          coalesce((p_req -> 'subject' ->> 'id')::uuid, (p_req -> 'scope' ->> 'id')::uuid),
          p_req ->> 'resolutionPoint', p_req -> 'scope' ->> 'kind', (p_req -> 'scope' ->> 'id')::uuid,
          (p_req ->> 'consumingBatchId')::uuid, (p_req ->> 'siteId')::uuid, v_key, v_version, v_as_of,
          array(select jsonb_array_elements_text(p_req -> 'markets')),
          coalesce(market.nz(p_req -> 'marketDerivation', null), '[]'::jsonb), coalesce(market.nz(p_req -> 'predicates', null), '{}'::jsonb),
          market.nz(p_req -> 'stated', null))
  returning * into e;
  return to_jsonb(e);
end
$$;

-- Phase 1 entry point for the application: derive the scope's markets and predicates from the
-- stub tables, check the key belongs to the scope's edition, and record the evaluation.
-- p_req: {key, scope: {kind, id}, consumingBatchId?, resolutionPoint, asOf, tableVersionId?,
-- predicates? (only attributes the scope does not already fix), stated?, subject?, siteId?}.
create function market.evaluate_stub_scope(p_req jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_key    text := p_req ->> 'key';
  v_table  text := market.table_of_key(p_req ->> 'key');
  v_scope  jsonb;
  v_pred   jsonb;
  v_extra  jsonb := coalesce(p_req -> 'predicates', '{}'::jsonb);
  v_attr   text;
  v_stated jsonb := market.nz(p_req -> 'stated', null);
begin
  if v_table is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-041 key %s belongs to no rule table', coalesce(v_key, '(missing)'));
  end if;
  v_scope := market.scope_markets(p_req -> 'scope' ->> 'kind', (p_req -> 'scope' ->> 'id')::uuid, v_table, (p_req ->> 'consumingBatchId')::uuid);
  if (v_table = 'tablets' and v_scope ->> 'edition' = 'injectables') or (v_table = 'sterile' and v_scope ->> 'edition' = 'tablets') then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-054 key %s belongs to the %s table and does not apply to a %s scope', v_key, v_table, v_scope ->> 'edition');
  end if;
  v_pred := v_scope -> 'predicates';
  if jsonb_typeof(v_extra) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-003 predicates must be an object of attribute values';
  end if;
  for v_attr in select jsonb_object_keys(v_extra) loop
    if v_pred ? v_attr and v_pred -> v_attr <> v_extra -> v_attr then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-055 predicate %s is fixed by the scope as %s and cannot be overridden', v_attr, (v_pred -> v_attr)::text);
    end if;
  end loop;
  v_pred := v_pred || v_extra;
  -- A PACK scope resolves a PER_DESTINATION key for its own destination.
  if v_stated is not null and v_scope ->> 'destination' is not null and (v_stated ->> 'destination') is null then
    v_stated := v_stated || jsonb_build_object('destination', v_scope ->> 'destination');
  end if;
  return market.record_evaluation(jsonb_build_object(
    'key', v_key, 'tableVersionId', p_req -> 'tableVersionId', 'scope', p_req -> 'scope',
    'consumingBatchId', p_req -> 'consumingBatchId', 'subject', p_req -> 'subject', 'resolutionPoint', p_req -> 'resolutionPoint',
    'asOf', p_req -> 'asOf', 'markets', v_scope -> 'markets', 'marketDerivation', v_scope -> 'derivation', 'predicates', v_pred,
    'stated', v_stated, 'siteId', coalesce(p_req -> 'siteId', v_scope -> 'siteId')));
end
$$;

-- Evaluations of a subject (e.g. a batch) that are flagged: a loosened GUIDANCE/EXAMPLE site value
-- was applied, or a site value in force could not be applied because it has become too loose.
create function market.batch_flags(p_subject uuid)
returns table (evaluation_id uuid, key text, site_outcome text, site_value_id uuid, resolved_value jsonb, effective_value jsonb, recorded_at timestamptz)
language sql stable security definer set search_path = pg_catalog, market, pg_temp as $$
  select e.id, e.key, e.site_outcome, e.site_value_id, e.resolved_value, e.effective_value, e.recorded_at
  from market.evaluation e
  where e.subject_id = p_subject and e.site_outcome in ('SITE_LOOSENED', 'SITE_VALUE_INADMISSIBLE')
  order by e.recorded_at, e.id
$$;

select kernel.register_audited_table('market.evaluation', 'market_evaluation', 'subject_id', true);

grant select on market.evaluation to ebmr_app;
grant execute on function market.evaluate_stub_scope(jsonb), market.batch_flags(uuid) to ebmr_app;
-- market.record_evaluation stays private to the owner (see above).

reset role;
