-- Market-profile engine, part 1: the rule model and the resolver (build outline 3.3.1, 3.3.2;
-- ADR 0008; control IN-52; invariants INV-28, INV-29).
--
-- Rules are data. A rule table (kernel, tablets, sterile) is published as numbered, immutable
-- versions; each version holds its key definitions and its rows. Keys are atomic (one dimension,
-- one unit) and carry an explicit comparison method. Rows carry market, optional predicate, value,
-- unit, floor type, source, verification status and an effective window [from, to). Nothing is ever
-- updated in place: a change is a new table version with new rows (0340 publishes them).
--
-- Values are JSON and never JSON numbers: decimals are canonical decimal strings, so no binary
-- floating point touches a GMP value (CLAUDE.md). Comparisons use PostgreSQL numeric.
--
-- The resolver below is the database twin of the pure TypeScript engine in
-- packages/kernel/src/market/resolve.ts; tests prove both give identical results.

create schema if not exists market authorization ebmr_owner;
revoke all on schema market from public;
grant usage on schema market to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Reference data: markets and rule tables
-- ---------------------------------------------------------------------------------------------

create table market.market (
  code            text primary key check (code ~ '^[A-Z]{2,8}$'),
  name            text not null,
  always_applies  boolean not null default false
);
comment on table market.market is 'Markets a batch can serve. IN always applies: every batch is made under an Indian licence (INV-28).';
insert into market.market (code, name, always_applies) values
  ('IN', 'India: Revised Schedule M and the Drugs Rules', true),
  ('US', 'United States: 21 CFR and FDA guidance', false),
  ('EU', 'European Union: EU GMP (EudraLex Volume 4)', false);

create table market.rule_table (
  code        text primary key check (code ~ '^[a-z][a-z0-9]*$'),
  key_prefix  text not null unique,
  title       text not null
);
comment on table market.rule_table is 'Separately versioned rule tables (L-57): a sterile change never creates change-control work for Tablets.';
insert into market.rule_table (code, key_prefix, title) values
  ('kernel', 'kernel.', 'Kernel keys used by both editions (retention, signatures, records, release)'),
  ('tablets', 'tablets.', 'Tablets edition keys'),
  ('sterile', 'sterile.', 'Injectables (sterile) edition keys');

-- ---------------------------------------------------------------------------------------------
-- Versions, keys and rows (insert-only; written only by market.publish_rule_table, 0340)
-- ---------------------------------------------------------------------------------------------

create table market.rule_table_version (
  id                   uuid primary key,
  table_code           text not null references market.rule_table (code),
  version              integer not null check (version >= 1),
  content_hash         bytea not null check (length(content_hash) = 32),
  change_kind          text not null check (change_kind in ('INITIAL', 'UPDATE', 'SOURCE_CORRECTION')),
  change_description   text not null check (length(trim(change_description)) > 0),
  citation             text,
  approver_ids         uuid[] not null default '{}',
  vendor_notice_ref    text,
  loosening            jsonb not null default '[]',
  source_file          text,
  source_sha256        text,
  previous_version_id  uuid references market.rule_table_version (id),
  key_count            integer not null,
  row_count            integer not null,
  published_at         timestamptz not null default clock_timestamp(),
  published_by         uuid not null,
  unique (table_code, version),
  check (change_kind <> 'SOURCE_CORRECTION' or (coalesce(length(trim(citation)), 0) > 0 and cardinality(approver_ids) >= 2))
);

create table market.rule_key (
  version_id        uuid not null references market.rule_table_version (id) deferrable initially deferred,
  key               text not null,
  title             text not null,
  method            text not null check (method in ('SMALLER_STRICTER', 'LARGER_STRICTER', 'ORDERED', 'REQUIRED_IF_ANY',
                                                    'SET_UNION', 'ALL_APPLY', 'NOT_COMPARABLE')),
  value_type        text not null check (value_type in ('DECIMAL', 'BOOLEAN', 'CATEGORY', 'SET', 'CRITERIA', 'ANY')),
  unit              text not null,
  ordered_values    jsonb,
  stated_method     text,
  india_governs     boolean not null,
  predicate_domain  jsonb not null default '{}',
  catalog_refs      text[] not null default '{}',
  description       text,
  primary key (version_id, key)
);

create table market.rule_row (
  id              uuid primary key default gen_random_uuid(),
  version_id      uuid not null references market.rule_table_version (id) deferrable initially deferred,
  row_ref         text not null,
  key             text not null,
  market          text not null references market.market (code),
  predicate       jsonb not null default '{}',
  value           jsonb not null,
  unit            text not null,
  floor_type      text not null check (floor_type in ('HARD', 'GUIDANCE', 'EXAMPLE', 'DESIGN')),
  hard_floor      jsonb,
  source          text not null check (length(trim(source)) > 0),
  verification    text not null check (verification in ('P', 'P~', 'S', 'U', 'CHK', 'GK')),
  effective_from  date not null,
  effective_to    date,
  note            text,
  row_hash        bytea not null,
  unique (version_id, row_ref),
  foreign key (version_id, key) references market.rule_key (version_id, key) deferrable initially deferred,
  check (effective_to is null or effective_to > effective_from),
  check (hard_floor is null or floor_type <> 'HARD')
);
create index rule_row_lookup on market.rule_row (version_id, key, market);

comment on column market.rule_row.floor_type is 'HARD = binding number; GUIDANCE = guidance value; EXAMPLE = a regulator''s example adopted as our default; DESIGN = our product choice.';
comment on column market.rule_row.hard_floor is 'For a non-HARD value: the binding regulatory value underneath it, which no site value may pass.';
comment on column market.rule_row.verification is 'P / P~ / S / U as in the India catalog; CHK = checked in the supplied primary text; GK = general knowledge, confirm before validation.';

-- ---------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------

create function market.nz(p jsonb, p_default jsonb) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select case when p is null or jsonb_typeof(p) = 'null' then p_default else p end
$$;

create function market.is_canonical_decimal(p text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p is not null and p ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' and p <> '-0'
$$;

create function market.has_json_number(p jsonb) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select jsonb_path_exists(p, 'lax $.** ? (@.type() == "number")')
$$;

create function market.is_identifier(p text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p is not null and p ~ '^[A-Za-z0-9][A-Za-z0-9_.:+-]*$'
$$;

create function market.parse_date(p text) returns date
language plpgsql immutable set search_path = pg_catalog as $$
declare
  d date;
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  d := p::date;
  if to_char(d, 'YYYY-MM-DD') <> p then
    return null;
  end if;
  return d;
exception when others then
  return null;
end
$$;

create function market.floor_rank(p text) returns integer
language sql immutable set search_path = pg_catalog as $$
  select case p when 'HARD' then 4 when 'GUIDANCE' then 3 when 'EXAMPLE' then 2 when 'DESIGN' then 1 else 0 end
$$;

-- GUIDANCE and adopted EXAMPLE values may be loosened by a site with a justification (CCS)
-- reference and QA approval; HARD and DESIGN values may not (ADR 0008 decision 8).
create function market.site_loosenable(p text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p in ('GUIDANCE', 'EXAMPLE')
$$;

create function market.table_of_key(p_key text) returns text
language sql stable security definer set search_path = pg_catalog, market as $$
  select t.code from market.rule_table t where left(p_key, length(t.key_prefix)) = t.key_prefix
$$;

create function market.category_rank(p_ordered jsonb, p_value jsonb) returns integer
language sql immutable set search_path = pg_catalog as $$
  select (select o.ord::integer from jsonb_array_elements(p_ordered) with ordinality as o(v, ord) where o.v = p_value)
$$;

create function market.criteria_ids(p jsonb) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select coalesce((select jsonb_agg(e -> 'id') from jsonb_array_elements(p) e), '[]'::jsonb)
$$;

-- Is value a at least as strict as value b under the key's method? NULL for NOT_COMPARABLE.
create function market.at_least_as_strict(p_method text, p_ordered jsonb, a jsonb, b jsonb) returns boolean
language sql immutable set search_path = pg_catalog, market as $$
  select case p_method
    when 'SMALLER_STRICTER' then (a #>> '{}')::numeric <= (b #>> '{}')::numeric
    when 'LARGER_STRICTER' then (a #>> '{}')::numeric >= (b #>> '{}')::numeric
    when 'ORDERED' then market.category_rank(p_ordered, a) >= market.category_rank(p_ordered, b)
    when 'REQUIRED_IF_ANY' then a = 'true'::jsonb or b = 'false'::jsonb
    when 'SET_UNION' then a @> b
    when 'ALL_APPLY' then market.criteria_ids(a) @> market.criteria_ids(b)
    else null
  end
$$;

-- Union of two set-valued values (SET_UNION: strings; ALL_APPLY: criteria by id), sorted.
create function market.set_merge(p_method text, a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, market as $$
  select case
    when a is null then b
    when b is null then a
    when p_method = 'SET_UNION' then
      (select coalesce(jsonb_agg(to_jsonb(s.el) order by s.el collate "C"), '[]'::jsonb)
         from (select distinct e #>> '{}' as el from jsonb_array_elements(a || b) e) s)
    else
      (select coalesce(jsonb_agg(s.c order by s.id collate "C"), '[]'::jsonb)
         from (select e ->> 'id' as id, (array_agg(e order by e::text))[1] as c from jsonb_array_elements(a || b) e group by 1) s)
  end
$$;

-- The binding (non-loosenable by a site) value of a row: its value if HARD, else its hard floor.
create function market.binding_value(p_floor text, p_value jsonb, p_hard_floor jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, market as $$
  select case when p_floor = 'HARD' then p_value else market.nz(p_hard_floor, null) end
$$;

-- A value's shape problem for a value type, or NULL when the value is well formed.
create function market.value_problem(p_type text, p_ordered jsonb, p_value jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, market as $$
declare
  e jsonb;
  v_seen text[] := '{}';
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return 'the value is missing';
  end if;
  if market.has_json_number(p_value) then
    return 'numbers must be written as quoted decimal strings, never as JSON numbers';
  end if;
  case p_type
    when 'DECIMAL' then
      if jsonb_typeof(p_value) <> 'string' or not market.is_canonical_decimal(p_value #>> '{}') then
        return format('%s is not a canonical decimal string (no exponent, no leading zeros, no trailing zeros)', p_value::text);
      end if;
    when 'BOOLEAN' then
      if jsonb_typeof(p_value) <> 'boolean' then
        return format('%s is not a boolean', p_value::text);
      end if;
    when 'CATEGORY' then
      if jsonb_typeof(p_value) <> 'string' or p_ordered is null or not (p_ordered @> jsonb_build_array(p_value)) then
        return format('%s is not one of the ordered values', p_value::text);
      end if;
    when 'SET' then
      if jsonb_typeof(p_value) <> 'array' then
        return 'a set value must be an array of identifiers';
      end if;
      for e in select x from jsonb_array_elements(p_value) x loop
        if jsonb_typeof(e) <> 'string' or not market.is_identifier(e #>> '{}') then
          return format('set element %s is not an identifier', e::text);
        end if;
        if (e #>> '{}') = any(v_seen) then
          return format('set element %s is repeated', e::text);
        end if;
        v_seen := v_seen || (e #>> '{}');
      end loop;
    when 'CRITERIA' then
      if jsonb_typeof(p_value) <> 'array' then
        return 'a criteria value must be an array of criterion objects';
      end if;
      for e in select x from jsonb_array_elements(p_value) x loop
        if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'id') is distinct from 'string' or not market.is_identifier(e ->> 'id') then
          return 'every criterion must be an object with an identifier in "id"';
        end if;
        if (e ->> 'id') = any(v_seen) then
          return format('criterion %s is repeated', e ->> 'id');
        end if;
        v_seen := v_seen || (e ->> 'id');
      end loop;
    when 'ANY' then
      null;
    else
      return format('unknown value type %s', coalesce(p_type, '(missing)'));
  end case;
  return null;
end
$$;

-- Validates a market set and returns it sorted. India must be present (INV-28).
create function market.checked_market_set(p text[]) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, market as $$
declare
  v_unknown text;
begin
  if p is null or cardinality(p) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-001 a market set is required';
  end if;
  if array_position(p, null) is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-001 a market set cannot contain an empty entry';
  end if;
  if (select count(distinct x) from unnest(p) x) <> cardinality(p) then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-001 market set %s repeats a market', p::text);
  end if;
  select x into v_unknown from unnest(p) x where not exists (select 1 from market.market m where m.code = x) limit 1;
  if v_unknown is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-001 unknown market %s', v_unknown);
  end if;
  if not ('IN' = any(p)) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-001 market set %s does not include IN: Indian GMP applies to every batch made under an Indian licence (INV-28)', p::text);
  end if;
  return (select array_agg(x order by x collate "C") from unnest(p) x);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Canonical form and content hash of a table version
-- ---------------------------------------------------------------------------------------------
-- The canonical form is built from the document form (the JSON the loader sends). A stored version
-- is converted back to document form by market.version_document, so the same function hashes both
-- and a published version can be compared with its source file.

create function market.canonical_key(k jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, market as $$
  select jsonb_build_object(
    'key', k -> 'key', 'title', k -> 'title', 'method', k -> 'method', 'valueType', k -> 'valueType', 'unit', k -> 'unit',
    'orderedValues', market.nz(k -> 'orderedValues', 'null'), 'statedMethod', market.nz(k -> 'statedMethod', 'null'),
    'indiaGoverns', k -> 'indiaGoverns', 'predicates', market.nz(k -> 'predicates', '{}'),
    'catalogRefs', market.nz(k -> 'catalogRefs', '[]'), 'description', market.nz(k -> 'description', 'null'))
$$;

create function market.canonical_row(r jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, market as $$
  select jsonb_build_object(
    'ref', r -> 'ref', 'key', r -> 'key', 'market', r -> 'market', 'predicate', market.nz(r -> 'predicate', '{}'),
    'value', r -> 'value', 'unit', r -> 'unit', 'floor', r -> 'floor', 'hardFloor', market.nz(r -> 'hardFloor', 'null'),
    'source', r -> 'source', 'verification', r -> 'verification', 'effectiveFrom', r -> 'effectiveFrom',
    'effectiveTo', market.nz(r -> 'effectiveTo', 'null'), 'note', market.nz(r -> 'note', 'null'))
$$;

create function market.document_content(p_doc jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, market as $$
  select jsonb_build_object(
    'table', p_doc -> 'table',
    'keys', coalesce((select jsonb_agg(market.canonical_key(k) order by k ->> 'key' collate "C")
                        from jsonb_array_elements(p_doc -> 'keys') k), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(market.canonical_row(r)
                               order by r ->> 'key' collate "C", r ->> 'market' collate "C",
                                        market.nz(r -> 'predicate', '{}')::text collate "C", r ->> 'effectiveFrom' collate "C",
                                        r ->> 'ref' collate "C")
                        from jsonb_array_elements(p_doc -> 'rows') r), '[]'::jsonb))
$$;

create function market.document_content_hash(p_doc jsonb) returns bytea
language sql immutable security definer set search_path = pg_catalog, market as $$
  select sha256(convert_to(market.document_content(p_doc)::text, 'UTF8'))
$$;

create function market.version_document(p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, market as $$
  select jsonb_build_object(
    'table', v.table_code,
    'version', v.version,
    'keys', coalesce((select jsonb_agg(jsonb_build_object(
                         'key', k.key, 'title', k.title, 'method', k.method, 'valueType', k.value_type, 'unit', k.unit,
                         'orderedValues', k.ordered_values, 'statedMethod', k.stated_method, 'indiaGoverns', k.india_governs,
                         'predicates', k.predicate_domain, 'catalogRefs', to_jsonb(k.catalog_refs), 'description', k.description)
                       order by k.key collate "C")
                     from market.rule_key k where k.version_id = v.id), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
                         'ref', r.row_ref, 'key', r.key, 'market', r.market, 'predicate', r.predicate, 'value', r.value,
                         'unit', r.unit, 'floor', r.floor_type, 'hardFloor', r.hard_floor, 'source', r.source,
                         'verification', r.verification, 'effectiveFrom', to_char(r.effective_from, 'YYYY-MM-DD'),
                         'effectiveTo', to_char(r.effective_to, 'YYYY-MM-DD'), 'note', r.note)
                       order by r.key collate "C", r.market collate "C", r.predicate::text collate "C", r.effective_from, r.row_ref collate "C")
                     from market.rule_row r where r.version_id = v.id), '[]'::jsonb))
  from market.rule_table_version v
  where v.id = p_version
$$;

-- ---------------------------------------------------------------------------------------------
-- Document validation (the publish gate; the TypeScript loader runs the same checks first)
-- ---------------------------------------------------------------------------------------------

create function market.validate_document(p_doc jsonb)
returns table (problem_code text, problem text)
language plpgsql stable security definer set search_path = pg_catalog, market as $$
declare
  v_table     text;
  v_prefix    text;
  k           jsonb;
  r           jsonb;
  f           text;
  v_keys      jsonb := '{}'::jsonb;
  v_key       jsonb;
  v_name      text;
  v_method    text;
  v_type      text;
  v_prob      text;
  v_refs      text[] := '{}';
  v_rows      jsonb := '[]'::jsonb;
  v_from      date;
  v_to        date;
  v_pred      jsonb;
  v_dom       jsonb;
  v_ok        boolean;
  e           record;
  q           record;
  v_lo        date;
  v_hi        date;
  v_hi_inf    boolean;
  v_methods   constant text[] := array['SMALLER_STRICTER', 'LARGER_STRICTER', 'ORDERED', 'REQUIRED_IF_ANY', 'SET_UNION', 'ALL_APPLY', 'NOT_COMPARABLE'];
  v_types     constant text[] := array['DECIMAL', 'BOOLEAN', 'CATEGORY', 'SET', 'CRITERIA', 'ANY'];
begin
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then
    problem_code := 'EBMR-MKT-010'; problem := 'a rule-table document must be a JSON object'; return next; return;
  end if;
  for f in select jsonb_object_keys(p_doc) loop
    if f not in ('table', 'version', 'title', 'change', 'keys', 'rows') then
      problem_code := 'EBMR-MKT-010'; problem := format('unknown document field "%s"', f); return next;
    end if;
  end loop;
  v_table := p_doc ->> 'table';
  select t.key_prefix into v_prefix from market.rule_table t where t.code = v_table;
  if v_prefix is null then
    problem_code := 'EBMR-MKT-011'; problem := format('unknown rule table "%s"', coalesce(v_table, '(missing)')); return next; return;
  end if;
  if jsonb_typeof(p_doc -> 'version') is distinct from 'number' then
    problem_code := 'EBMR-MKT-010'; problem := 'version must be a positive integer'; return next;
  elsif (p_doc ->> 'version') !~ '^[1-9][0-9]{0,5}$' then
    problem_code := 'EBMR-MKT-010'; problem := 'version must be a positive integer'; return next;
  end if;
  if jsonb_typeof(p_doc -> 'keys') is distinct from 'array' then
    problem_code := 'EBMR-MKT-010'; problem := 'keys must be a non-empty array'; return next; return;
  end if;
  if jsonb_array_length(p_doc -> 'keys') = 0 then
    problem_code := 'EBMR-MKT-010'; problem := 'keys must be a non-empty array'; return next; return;
  end if;
  if jsonb_typeof(p_doc -> 'rows') is distinct from 'array' then
    problem_code := 'EBMR-MKT-010'; problem := 'rows must be an array'; return next; return;
  end if;

  -- Keys --------------------------------------------------------------------------------------
  for k in select x.v from jsonb_array_elements(p_doc -> 'keys') x(v) loop
    if jsonb_typeof(k) <> 'object' then
      problem_code := 'EBMR-MKT-010'; problem := 'every key must be an object'; return next; continue;
    end if;
    for f in select jsonb_object_keys(k) loop
      if f not in ('key', 'title', 'method', 'valueType', 'unit', 'orderedValues', 'statedMethod', 'indiaGoverns', 'predicates', 'catalogRefs', 'description') then
        problem_code := 'EBMR-MKT-010'; problem := format('key %s: unknown field "%s"', coalesce(k ->> 'key', '?'), f); return next;
      end if;
    end loop;
    v_name := k ->> 'key';
    if jsonb_typeof(k -> 'key') is distinct from 'string' or v_name !~ '^[a-z][a-z0-9]*(\.[A-Za-z][A-Za-z0-9_]*)+$' then
      problem_code := 'EBMR-MKT-013'; problem := format('key name %s is not a dotted identifier', coalesce(k ->> 'key', '(missing)')); return next; continue;
    end if;
    if left(v_name, length(v_prefix)) <> v_prefix then
      problem_code := 'EBMR-MKT-013'; problem := format('key %s does not belong to table %s (namespace %s*)', v_name, v_table, v_prefix); return next; continue;
    end if;
    if v_keys ? v_name then
      problem_code := 'EBMR-MKT-013'; problem := format('key %s is defined twice', v_name); return next; continue;
    end if;
    if jsonb_typeof(k -> 'title') is distinct from 'string' or length(trim(k ->> 'title')) = 0 then
      problem_code := 'EBMR-MKT-010'; problem := format('key %s needs a title', v_name); return next;
    end if;
    if k ? 'description' and jsonb_typeof(k -> 'description') not in ('string', 'null') then
      problem_code := 'EBMR-MKT-010'; problem := format('key %s: description must be text', v_name); return next;
    end if;
    if jsonb_typeof(k -> 'indiaGoverns') is distinct from 'boolean' then
      problem_code := 'EBMR-MKT-010'; problem := format('key %s: indiaGoverns must be true or false', v_name); return next;
    end if;
    if k ? 'catalogRefs' and jsonb_typeof(k -> 'catalogRefs') <> 'null' then
      if (case when jsonb_typeof(k -> 'catalogRefs') <> 'array' then true
               else exists (select 1 from jsonb_array_elements(k -> 'catalogRefs') c
                             where jsonb_typeof(c) <> 'string' or (c #>> '{}') !~ '^(B|DI|PR|ST|IN)-[0-9]{2}$') end) then
        problem_code := 'EBMR-MKT-010'; problem := format('key %s: catalogRefs must list ids such as B-01 or IN-08', v_name); return next;
      end if;
    end if;
    if jsonb_typeof(k -> 'unit') is distinct from 'string' or (k ->> 'unit') !~ '^\S{1,40}$' then
      problem_code := 'EBMR-MKT-010'; problem := format('key %s needs a unit', v_name); return next;
    end if;
    v_method := k ->> 'method';
    v_type := k ->> 'valueType';
    if v_method is null or not (v_method = any(v_methods)) then
      problem_code := 'EBMR-MKT-014'; problem := format('key %s: unknown comparison method %s', v_name, coalesce(v_method, '(missing)')); return next;
    end if;
    if v_type is null or not (v_type = any(v_types)) then
      problem_code := 'EBMR-MKT-015'; problem := format('key %s: unknown value type %s', v_name, coalesce(v_type, '(missing)')); return next;
    elsif v_method = any(v_methods) then
      if v_method in ('SMALLER_STRICTER', 'LARGER_STRICTER', 'ORDERED', 'REQUIRED_IF_ANY') and v_type in ('SET', 'CRITERIA', 'ANY') then
        problem_code := 'EBMR-MKT-015'; problem := format('key %s: scalar method %s on a multi-component key (value type %s)', v_name, v_method, v_type); return next;
      elsif (v_method in ('SMALLER_STRICTER', 'LARGER_STRICTER') and v_type <> 'DECIMAL')
         or (v_method = 'ORDERED' and v_type <> 'CATEGORY')
         or (v_method = 'REQUIRED_IF_ANY' and v_type <> 'BOOLEAN')
         or (v_method = 'SET_UNION' and v_type <> 'SET')
         or (v_method = 'ALL_APPLY' and v_type <> 'CRITERIA') then
        problem_code := 'EBMR-MKT-015'; problem := format('key %s: method %s does not fit value type %s', v_name, v_method, v_type); return next;
      end if;
    end if;
    if v_method = 'ORDERED' or v_type = 'CATEGORY' then
      if (case when jsonb_typeof(k -> 'orderedValues') is distinct from 'array' then true
               when jsonb_array_length(k -> 'orderedValues') = 0 then true
               when exists (select 1 from jsonb_array_elements(k -> 'orderedValues') c
                             where jsonb_typeof(c) <> 'string' or not market.is_identifier(c #>> '{}')) then true
               else (select count(distinct c) from jsonb_array_elements(k -> 'orderedValues') c) <> jsonb_array_length(k -> 'orderedValues') end) then
        problem_code := 'EBMR-MKT-016'; problem := format('key %s: orderedValues must list distinct identifiers from least to most strict', v_name); return next;
      end if;
    elsif k ? 'orderedValues' and jsonb_typeof(k -> 'orderedValues') <> 'null' then
      problem_code := 'EBMR-MKT-016'; problem := format('key %s: orderedValues is only for ORDERED keys', v_name); return next;
    end if;
    if v_method = 'NOT_COMPARABLE' then
      if (k ->> 'statedMethod') is distinct from 'PER_DESTINATION' then
        problem_code := 'EBMR-MKT-016'; problem := format('key %s: a NOT_COMPARABLE key needs a stated method (PER_DESTINATION)', v_name); return next;
      end if;
    elsif k ? 'statedMethod' and jsonb_typeof(k -> 'statedMethod') <> 'null' then
      problem_code := 'EBMR-MKT-016'; problem := format('key %s: statedMethod is only for NOT_COMPARABLE keys', v_name); return next;
    end if;
    v_dom := market.nz(k -> 'predicates', '{}');
    if jsonb_typeof(v_dom) <> 'object' then
      problem_code := 'EBMR-MKT-022'; problem := format('key %s: predicates must map attribute names to their allowed values', v_name); return next;
    else
      for e in select * from jsonb_each(v_dom) loop
        if (case when e.key !~ '^[a-z][A-Za-z0-9]*$' then true
                 when jsonb_typeof(e.value) <> 'array' then true
                 when jsonb_array_length(e.value) = 0 then true
                 when exists (select 1 from jsonb_array_elements(e.value) c where jsonb_typeof(c) not in ('string', 'boolean')) then true
                 else (select count(distinct c) from jsonb_array_elements(e.value) c) <> jsonb_array_length(e.value) end) then
          problem_code := 'EBMR-MKT-022'; problem := format('key %s: predicate %s needs a list of distinct text or true/false values', v_name, e.key); return next;
        end if;
      end loop;
    end if;
    v_keys := v_keys || jsonb_build_object(v_name, k);
  end loop;

  -- Rows --------------------------------------------------------------------------------------
  for r in select x.v from jsonb_array_elements(p_doc -> 'rows') x(v) loop
    if jsonb_typeof(r) <> 'object' then
      problem_code := 'EBMR-MKT-010'; problem := 'every row must be an object'; return next; continue;
    end if;
    for f in select jsonb_object_keys(r) loop
      if f not in ('ref', 'key', 'market', 'predicate', 'value', 'unit', 'floor', 'hardFloor', 'source', 'verification', 'effectiveFrom', 'effectiveTo', 'note') then
        problem_code := 'EBMR-MKT-010'; problem := format('row %s: unknown field "%s"', coalesce(r ->> 'ref', '?'), f); return next;
      end if;
    end loop;
    v_name := coalesce(r ->> 'ref', '?');
    v_ok := true;
    if jsonb_typeof(r -> 'ref') is distinct from 'string' or not market.is_identifier(r ->> 'ref') then
      problem_code := 'EBMR-MKT-029'; problem := format('row %s needs an identifier in "ref"', v_name); return next; v_ok := false;
    elsif (r ->> 'ref') = any(v_refs) then
      problem_code := 'EBMR-MKT-029'; problem := format('row ref %s is used twice', v_name); return next; v_ok := false;
    else
      v_refs := v_refs || (r ->> 'ref');
    end if;
    v_key := v_keys -> (r ->> 'key');
    if v_key is null then
      problem_code := 'EBMR-MKT-017'; problem := format('row %s refers to key %s, which this table does not define', v_name, coalesce(r ->> 'key', '(missing)')); return next;
      continue;
    end if;
    if not exists (select 1 from market.market m where m.code = r ->> 'market') then
      problem_code := 'EBMR-MKT-018'; problem := format('row %s: unknown market %s', v_name, coalesce(r ->> 'market', '(missing)')); return next; v_ok := false;
    end if;
    if (r ->> 'unit') is distinct from (v_key ->> 'unit') then
      problem_code := 'EBMR-MKT-019'; problem := format('row %s: unit %s does not match the unit %s of key %s', v_name, coalesce(r ->> 'unit', '(missing)'), v_key ->> 'unit', v_key ->> 'key'); return next; v_ok := false;
    end if;
    v_prob := market.value_problem(v_key ->> 'valueType', v_key -> 'orderedValues', r -> 'value');
    if v_prob is not null then
      problem_code := 'EBMR-MKT-020'; problem := format('row %s: %s', v_name, v_prob); return next; v_ok := false;
    end if;
    if (r ->> 'floor') is null or (r ->> 'floor') not in ('HARD', 'GUIDANCE', 'EXAMPLE', 'DESIGN') then
      problem_code := 'EBMR-MKT-021'; problem := format('row %s: floor must be HARD, GUIDANCE, EXAMPLE or DESIGN', v_name); return next; v_ok := false;
    end if;
    if (r ->> 'verification') is null or (r ->> 'verification') not in ('P', 'P~', 'S', 'U', 'CHK', 'GK') then
      problem_code := 'EBMR-MKT-021'; problem := format('row %s: verification must be P, P~, S, U, CHK or GK', v_name); return next; v_ok := false;
    end if;
    if jsonb_typeof(r -> 'source') is distinct from 'string' or length(trim(r ->> 'source')) = 0 then
      problem_code := 'EBMR-MKT-021'; problem := format('row %s needs a source citation', v_name); return next; v_ok := false;
    end if;
    if r ? 'note' and jsonb_typeof(r -> 'note') not in ('string', 'null') then
      problem_code := 'EBMR-MKT-021'; problem := format('row %s: note must be text', v_name); return next; v_ok := false;
    end if;
    v_from := market.parse_date(r ->> 'effectiveFrom');
    v_to := market.parse_date(market.nz(r -> 'effectiveTo', null) #>> '{}');
    if jsonb_typeof(r -> 'effectiveFrom') is distinct from 'string' or v_from is null then
      problem_code := 'EBMR-MKT-021'; problem := format('row %s: effectiveFrom must be a date written YYYY-MM-DD', v_name); return next; v_ok := false;
    end if;
    if market.nz(r -> 'effectiveTo', null) is not null and (jsonb_typeof(r -> 'effectiveTo') <> 'string' or v_to is null or (v_from is not null and v_to <= v_from)) then
      problem_code := 'EBMR-MKT-021'; problem := format('row %s: effectiveTo must be a date after effectiveFrom', v_name); return next; v_ok := false;
    end if;
    v_pred := market.nz(r -> 'predicate', '{}');
    v_dom := market.nz(v_key -> 'predicates', '{}');
    if jsonb_typeof(v_pred) <> 'object' then
      problem_code := 'EBMR-MKT-022'; problem := format('row %s: predicate must be an object', v_name); return next; v_ok := false;
    else
      for e in select * from jsonb_each(v_pred) loop
        if jsonb_typeof(v_dom) <> 'object' or not (v_dom ? e.key) or jsonb_typeof(v_dom -> e.key) <> 'array' or not ((v_dom -> e.key) @> jsonb_build_array(e.value)) then
          problem_code := 'EBMR-MKT-022'; problem := format('row %s: predicate %s = %s is not declared on key %s', v_name, e.key, e.value::text, v_key ->> 'key'); return next; v_ok := false;
        end if;
      end loop;
    end if;
    if market.nz(r -> 'hardFloor', null) is not null then
      if (r ->> 'floor') = 'HARD' then
        problem_code := 'EBMR-MKT-023'; problem := format('row %s: a HARD value is its own floor; hardFloor is only for GUIDANCE, EXAMPLE or DESIGN values', v_name); return next; v_ok := false;
      elsif (v_key ->> 'method') = 'NOT_COMPARABLE' then
        problem_code := 'EBMR-MKT-023'; problem := format('row %s: a NOT_COMPARABLE key has no hard floor', v_name); return next; v_ok := false;
      elsif market.value_problem(v_key ->> 'valueType', v_key -> 'orderedValues', r -> 'hardFloor') is not null then
        problem_code := 'EBMR-MKT-023'; problem := format('row %s: hardFloor: %s', v_name, market.value_problem(v_key ->> 'valueType', v_key -> 'orderedValues', r -> 'hardFloor')); return next; v_ok := false;
      elsif v_prob is null and (v_key ->> 'method') = any(v_methods) and (v_key ->> 'valueType') = any(v_types)
            and not market.at_least_as_strict(v_key ->> 'method', v_key -> 'orderedValues', r -> 'value', r -> 'hardFloor') then
        problem_code := 'EBMR-MKT-023'; problem := format('row %s: the value is looser than its own hard floor', v_name); return next; v_ok := false;
      end if;
    end if;
    if v_ok then
      v_rows := v_rows || jsonb_build_array(r);
    end if;
  end loop;

  -- Cross-row checks on the well-formed rows ---------------------------------------------------
  for q in
    with rr as (
      select t.ord, t.r ->> 'ref' as ref, t.r ->> 'key' as key, t.r ->> 'market' as mkt, market.nz(t.r -> 'predicate', '{}') as pred,
             daterange((t.r ->> 'effectiveFrom')::date, (market.nz(t.r -> 'effectiveTo', null) #>> '{}')::date, '[)') as win
      from jsonb_array_elements(v_rows) with ordinality t(r, ord))
    select a.ref as ref1, b.ref as ref2, a.key, a.mkt, a.pred, (a.pred = b.pred) as same_pred
    from rr a join rr b on a.ord < b.ord and a.key = b.key and a.mkt = b.mkt and a.win && b.win
    where a.pred = b.pred
       or (not (a.pred @> b.pred) and not (b.pred @> a.pred)
           and not exists (select 1 from jsonb_each(a.pred) pe where b.pred ? pe.key and b.pred -> pe.key <> pe.value))
    order by a.ord, b.ord
  loop
    if q.same_pred then
      problem_code := 'EBMR-MKT-024';
      problem := format('rows %s and %s: overlapping effective windows for key %s, market %s, predicate %s', q.ref1, q.ref2, q.key, q.mkt, q.pred::text);
    else
      problem_code := 'EBMR-MKT-025';
      problem := format('rows %s and %s: predicates overlap without one refining the other (key %s, market %s), so the branch would be ambiguous', q.ref1, q.ref2, q.key, q.mkt);
    end if;
    return next;
  end loop;

  for v_name in select jsonb_object_keys(v_keys) loop
    v_key := v_keys -> v_name;
    if (v_key ->> 'indiaGoverns') = 'true' then
      select min((t.r ->> 'effectiveFrom')::date) into v_lo
        from jsonb_array_elements(v_rows) t(r) where t.r ->> 'key' = v_name and t.r ->> 'market' = 'IN';
      if v_lo is null then
        problem_code := 'EBMR-MKT-026'; problem := format('key %s is governed by India but has no India (IN) row', v_name); return next; continue;
      end if;
      select bool_or(market.nz(t.r -> 'effectiveTo', null) is null), max((t.r ->> 'effectiveTo')::date)
        into v_hi_inf, v_hi
        from jsonb_array_elements(v_rows) t(r) where t.r ->> 'key' = v_name;
      if not (datemultirange(daterange(v_lo, case when v_hi_inf then null else v_hi end, '[)')) <@
              (select range_agg(daterange((t.r ->> 'effectiveFrom')::date, (market.nz(t.r -> 'effectiveTo', null) #>> '{}')::date, '[)'))
                 from jsonb_array_elements(v_rows) t(r) where t.r ->> 'key' = v_name and t.r ->> 'market' = 'IN')) then
        problem_code := 'EBMR-MKT-026'; problem := format('key %s is governed by India but India (IN) rows leave a gap in the effective period', v_name); return next;
      end if;
    elsif exists (select 1 from jsonb_array_elements(v_rows) t(r) where t.r ->> 'key' = v_name and t.r ->> 'market' = 'IN') then
      problem_code := 'EBMR-MKT-027'; problem := format('key %s says India does not govern it but has India (IN) rows', v_name); return next;
    end if;
  end loop;

  for q in
    select t.r ->> 'key' as key, c ->> 'id' as id
    from jsonb_array_elements(v_rows) t(r),
         jsonb_array_elements(case when (v_keys -> (t.r ->> 'key') ->> 'method') = 'ALL_APPLY'
                                   then (t.r -> 'value') || coalesce(market.nz(t.r -> 'hardFloor', null), '[]'::jsonb)
                                   else '[]'::jsonb end) c
    group by 1, 2
    having count(distinct c::text) > 1
    order by 1, 2
  loop
    problem_code := 'EBMR-MKT-028'; problem := format('key %s: criterion %s is defined differently in different rows', q.key, q.id); return next;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------------------------

-- The row that applies for one market: the most specific effective row whose predicate is
-- contained in the given predicates. Equal specificity is ambiguous and refused.
create function market.select_row(p_version uuid, p_key text, p_market text, p_predicates jsonb, p_at date)
returns market.rule_row
language plpgsql stable security definer set search_path = pg_catalog, market as $$
declare
  r market.rule_row;
  v_best market.rule_row;
  v_spec integer;
  v_found boolean := false;
begin
  for r in
    select rr.* from market.rule_row rr
    where rr.version_id = p_version and rr.key = p_key and rr.market = p_market
      and daterange(rr.effective_from, rr.effective_to, '[)') @> p_at
      and rr.predicate <@ p_predicates
    order by (select count(*) from jsonb_object_keys(rr.predicate)) desc, rr.row_ref collate "C"
    limit 2
  loop
    if not v_found then
      v_best := r;
      v_spec := (select count(*) from jsonb_object_keys(r.predicate));
      v_found := true;
    elsif (select count(*) from jsonb_object_keys(r.predicate)) = v_spec then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-044 rows %s and %s both apply to key %s for market %s: ambiguous predicate branch', v_best.row_ref, r.row_ref, p_key, p_market);
    end if;
  end loop;
  return v_best;
end
$$;

create function market.resolve(p_version uuid, p_key text, p_markets text[], p_predicates jsonb, p_as_of date, p_stated jsonb default null)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market as $$
declare
  v_ver         market.rule_table_version;
  k             market.rule_key;
  r             market.rule_row;
  v_markets     text[];
  v_pred        jsonb := coalesce(p_predicates, '{}'::jsonb);
  v_attr        text;
  m             text;
  c             jsonb;
  v_contribs    jsonb := '[]'::jsonb;
  v_branch      jsonb := '{}'::jsonb;
  v_in          jsonb;
  v_value       jsonb;
  v_governing   text[] := '{}';
  v_floor       text;
  v_hard        jsonb;
  v_binding     jsonb;
  v_components  jsonb;
  v_stated      jsonb;
  v_dest        text;
  v_inputs      jsonb;
begin
  v_markets := market.checked_market_set(p_markets);
  if p_as_of is null then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-002 a resolution needs an as-of date';
  end if;
  if jsonb_typeof(v_pred) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-003 predicates must be an object of attribute values';
  end if;
  select * into v_ver from market.rule_table_version where id = p_version;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-040 unknown rule-table version %s', p_version);
  end if;
  select * into k from market.rule_key where version_id = p_version and key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-041 key %s is not in rule table %s version %s', p_key, v_ver.table_code, v_ver.version);
  end if;
  v_inputs := jsonb_build_object('key', p_key, 'tableVersionId', p_version, 'marketSet', to_jsonb(v_markets), 'predicates', v_pred,
                                 'asOf', to_char(p_as_of, 'YYYY-MM-DD'), 'stated', p_stated);

  -- Every predicate attribute that an applicable row uses must be supplied (fail closed).
  for v_attr in
    select distinct pe.key
    from market.rule_row rr, jsonb_each(rr.predicate) pe
    where rr.version_id = p_version and rr.key = p_key and rr.market = any(v_markets)
      and daterange(rr.effective_from, rr.effective_to, '[)') @> p_as_of
    order by 1
  loop
    if not (v_pred ? v_attr) then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-042 key %s needs predicate %s to choose its branch', p_key, v_attr);
    end if;
    if not coalesce((k.predicate_domain -> v_attr) @> jsonb_build_array(v_pred -> v_attr), false) then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-043 predicate %s = %s is outside the values declared for key %s', v_attr, (v_pred -> v_attr)::text, p_key);
    end if;
  end loop;

  foreach m in array v_markets loop
    r := market.select_row(p_version, p_key, m, v_pred, p_as_of);
    if r.id is not null then
      c := jsonb_build_object('market', m, 'rowId', r.id, 'rowRef', r.row_ref, 'value', r.value, 'floorType', r.floor_type,
                              'hardFloor', r.hard_floor, 'predicate', r.predicate);
      v_contribs := v_contribs || jsonb_build_array(c);
      v_branch := v_branch || jsonb_build_object(m, r.predicate);
    end if;
  end loop;

  select x into v_in from jsonb_array_elements(v_contribs) x where x ->> 'market' = 'IN';
  if k.india_governs and v_in is null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-045 key %s has no India value for predicates %s on %s; India always applies, so the resolution is refused', p_key, v_pred::text, to_char(p_as_of, 'YYYY-MM-DD'));
  end if;

  if jsonb_array_length(v_contribs) = 0 then
    return jsonb_build_object(
      'key', k.key, 'tableCode', v_ver.table_code, 'tableVersionId', v_ver.id, 'tableVersion', v_ver.version,
      'method', k.method, 'valueType', k.value_type, 'unit', k.unit, 'applicable', false, 'value', null,
      'governingMarkets', '[]'::jsonb, 'floorType', null, 'hardFloor', null, 'predicateBranch', '{}'::jsonb,
      'contributions', '[]'::jsonb, 'components', null, 'stated', null, 'inputs', v_inputs);
  end if;

  if k.method in ('SMALLER_STRICTER', 'LARGER_STRICTER', 'ORDERED', 'REQUIRED_IF_ANY') then
    for c in select x from jsonb_array_elements(v_contribs) x loop
      if v_value is null or not market.at_least_as_strict(k.method, k.ordered_values, v_value, c -> 'value') then
        v_value := c -> 'value';
      end if;
    end loop;
    select coalesce(array_agg(x ->> 'market' order by x ->> 'market' collate "C"), '{}') into v_governing
      from jsonb_array_elements(v_contribs) x where x -> 'value' = v_value;
  elsif k.method = 'SET_UNION' then
    select coalesce(jsonb_agg(jsonb_build_object('value', to_jsonb(s.el), 'markets', to_jsonb(s.markets), 'floorType', s.floor) order by s.el collate "C"), '[]'::jsonb),
           coalesce(jsonb_agg(to_jsonb(s.el) order by s.el collate "C"), '[]'::jsonb)
      into v_components, v_value
      from (select e #>> '{}' as el,
                   array_agg(x ->> 'market' order by x ->> 'market' collate "C") as markets,
                   (array_agg(x ->> 'floorType' order by market.floor_rank(x ->> 'floorType') desc))[1] as floor
              from jsonb_array_elements(v_contribs) x, jsonb_array_elements(x -> 'value') e
             group by 1) s;
    select coalesce(array_agg(x ->> 'market' order by x ->> 'market' collate "C"), '{}') into v_governing
      from jsonb_array_elements(v_contribs) x where jsonb_array_length(x -> 'value') > 0;
  elsif k.method = 'ALL_APPLY' then
    select coalesce(jsonb_agg(jsonb_build_object('value', s.crit, 'markets', to_jsonb(s.markets), 'floorType', s.floor) order by s.id collate "C"), '[]'::jsonb),
           coalesce(jsonb_agg(s.crit order by s.id collate "C"), '[]'::jsonb)
      into v_components, v_value
      from (select e ->> 'id' as id,
                   (array_agg(e order by x ->> 'market' collate "C"))[1] as crit,
                   array_agg(x ->> 'market' order by x ->> 'market' collate "C") as markets,
                   (array_agg(x ->> 'floorType' order by market.floor_rank(x ->> 'floorType') desc))[1] as floor
              from jsonb_array_elements(v_contribs) x, jsonb_array_elements(x -> 'value') e
             group by 1) s;
    select coalesce(array_agg(x ->> 'market' order by x ->> 'market' collate "C"), '{}') into v_governing
      from jsonb_array_elements(v_contribs) x where jsonb_array_length(x -> 'value') > 0;
  else
    -- NOT_COMPARABLE: the author states the method (PER_DESTINATION) and its decision reference.
    if p_stated is null or jsonb_typeof(p_stated) <> 'object' then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-046 key %s cannot be ranked across markets; resolving it needs a stated method (%s) with a regulatory decision reference', p_key, k.stated_method);
    end if;
    if (p_stated ->> 'method') is distinct from k.stated_method then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-046 key %s must be resolved by stated method %s', p_key, k.stated_method);
    end if;
    v_dest := p_stated ->> 'destination';
    if v_dest is null or not (v_dest = any(v_markets)) then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-047 destination %s is not in the market set %s', coalesce(v_dest, '(missing)'), v_markets::text);
    end if;
    if coalesce(trim(p_stated ->> 'decisionRef'), '') = '' then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-047 key %s needs a regulatory decision reference for destination %s', p_key, v_dest);
    end if;
    select x into c from jsonb_array_elements(v_contribs) x where x ->> 'market' = v_dest;
    if c is null then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-047 key %s has no row for destination %s', p_key, v_dest);
    end if;
    v_value := c -> 'value';
    v_governing := array[v_dest];
    v_stated := jsonb_build_object('method', k.stated_method, 'destination', v_dest, 'decisionRef', p_stated ->> 'decisionRef');
  end if;

  select x ->> 'floorType' into v_floor
    from jsonb_array_elements(v_contribs) x
   where x ->> 'market' = any(v_governing)
   order by market.floor_rank(x ->> 'floorType') desc
   limit 1;

  if k.method <> 'NOT_COMPARABLE' then
    for c in select x from jsonb_array_elements(v_contribs) x loop
      v_binding := market.binding_value(c ->> 'floorType', c -> 'value', c -> 'hardFloor');
      if v_binding is not null then
        if k.method in ('SET_UNION', 'ALL_APPLY') then
          v_hard := market.set_merge(k.method, v_hard, v_binding);
        elsif v_hard is null or not market.at_least_as_strict(k.method, k.ordered_values, v_hard, v_binding) then
          v_hard := v_binding;
        end if;
      end if;
    end loop;
    -- INV-28 second line: the result is never looser than India's value.
    if v_in is not null and not market.at_least_as_strict(k.method, k.ordered_values, v_value, v_in -> 'value') then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-049 internal error: key %s resolved looser than India (INV-28)', p_key);
    end if;
  end if;

  return jsonb_build_object(
    'key', k.key, 'tableCode', v_ver.table_code, 'tableVersionId', v_ver.id, 'tableVersion', v_ver.version,
    'method', k.method, 'valueType', k.value_type, 'unit', k.unit, 'applicable', true, 'value', v_value,
    'governingMarkets', to_jsonb(v_governing), 'floorType', v_floor, 'hardFloor', v_hard, 'predicateBranch', v_branch,
    'contributions', v_contribs, 'components', v_components, 'stated', v_stated, 'inputs', v_inputs);
end
$$;

-- Latest published version of a table (NULL if none).
create function market.current_version(p_table text) returns uuid
language sql stable security definer set search_path = pg_catalog, market as $$
  select v.id from market.rule_table_version v where v.table_code = p_table order by v.version desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit registration and privileges
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('market.market', 'market', 'code', false);
select kernel.register_audited_table('market.rule_table_version', 'rule_table', 'table_code', true);
select kernel.register_audited_table('market.rule_key', 'rule_table_version', 'version_id', true);
select kernel.register_audited_table('market.rule_row', 'rule_table_version', 'version_id', true);

grant select on market.market, market.rule_table, market.rule_table_version, market.rule_key, market.rule_row to ebmr_app;
grant execute on function market.resolve(uuid, text, text[], jsonb, date, jsonb), market.validate_document(jsonb),
                          market.document_content_hash(jsonb), market.version_document(uuid), market.current_version(text),
                          market.checked_market_set(text[]) to ebmr_app;

reset role;
