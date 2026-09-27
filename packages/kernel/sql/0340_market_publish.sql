-- Market-profile engine, part 5: publishing rule-table versions, change classification, change
-- impact and verification (build outline 3.3.1, 3.3.5, 3.6; ADR 0008 decisions 5, 8, 11; IN-52).
--
-- market.publish_rule_table is the only writer of rule-table versions, keys and rows. It:
--   1. validates the document (market.validate_document) and refuses it on any problem;
--   2. requires the next version number of that table (tables are versioned separately, L-57);
--   3. stores keys and rows (insert-only) and a SHA-256 content hash of the canonical content;
--   4. compares the new version with the previous one, date by date and for every predicate
--      branch: any loosening that reaches today or earlier (retroactive) is refused unless the
--      version is a SOURCE_CORRECTION, which needs a citation and two approvers other than the
--      publisher (L-38). A loosening that starts in the future (a regulatory relaxation with a later
--      legal effective date) is allowed and recorded on the version;
--   5. writes the change-impact list: stub MBR limits and site values whose pinned value is looser
--      than the new resolved value, due by the rule's effective date (3.3.5).

set local role ebmr_owner;

create table market.change_impact (
  id                 uuid primary key default gen_random_uuid(),
  version_id         uuid not null references market.rule_table_version (id),
  ref_type           text not null check (ref_type in ('MBR_LIMIT', 'SITE_VALUE')),
  ref_id             uuid not null,
  ref_label          text not null,
  key                text not null,
  market_set         text[] not null,
  pinned_value       jsonb not null,
  required_value     jsonb,
  governing_markets  text[] not null default '{}',
  due_by             date not null,
  problem            text,
  note               text,
  recorded_at        timestamptz not null default clock_timestamp()
);
create index change_impact_version on market.change_impact (version_id);
comment on table market.change_impact is 'Impact list of a published rule-table version: references that must be tightened before due_by (tracked change tasks later).';

-- All combinations of predicate values over the attributes the key's rows use (for comparison).
create function market.predicate_combinations(p_domain jsonb, p_attrs text[]) returns jsonb
language plpgsql immutable set search_path = pg_catalog, market, pg_temp as $$
declare
  v_out jsonb := '[{}]'::jsonb;
  v_next jsonb;
  a text;
begin
  foreach a in array coalesce(p_attrs, '{}') loop
    select coalesce(jsonb_agg(c || jsonb_build_object(a, v) order by c::text, v::text), '[]'::jsonb) into v_next
      from jsonb_array_elements(v_out) c, jsonb_array_elements(coalesce(p_domain -> a, '[]'::jsonb)) v;
    v_out := v_next;
  end loop;
  return v_out;
end
$$;

-- Loosenings from p_prev to p_new: a list of {kind, key, market, predicate, from, to, aspects,
-- retroactive}. Rows are compared per market, per predicate branch and per date segment, using the
-- same row selection as the resolver, so a new, more specific but looser row is caught too.
create function market.classify_changes(p_prev uuid, p_new uuid, p_today date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v_out      jsonb := '[]'::jsonb;
  ok         market.rule_key;
  nk         market.rule_key;
  v_mkt      text;
  v_attrs    text[];
  v_dates    date[];
  i          integer;
  v_from     date;
  v_to       date;
  v_combo    jsonb;
  o          market.rule_row;
  n          market.rule_row;
  v_aspects  text[];
  v_ob       jsonb;
  v_nb       jsonb;
begin
  for ok in select * from market.rule_key where version_id = p_prev order by key collate "C" loop
    select * into nk from market.rule_key where version_id = p_new and key = ok.key;
    if not found then
      v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'KEY_REMOVED', 'key', ok.key, 'retroactive', true));
      continue;
    end if;
    if (nk.method, nk.value_type, nk.unit, nk.ordered_values, nk.stated_method, nk.india_governs)
         is distinct from (ok.method, ok.value_type, ok.unit, ok.ordered_values, ok.stated_method, ok.india_governs)
       or not (nk.predicate_domain @> ok.predicate_domain) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'KEY_REDEFINED', 'key', ok.key, 'retroactive', true));
      continue;
    end if;
    for v_mkt in select distinct r.market from market.rule_row r where r.version_id = p_prev and r.key = ok.key order by 1 loop
      select coalesce(array_agg(distinct pe.key order by pe.key), '{}') into v_attrs
        from market.rule_row r, jsonb_each(r.predicate) pe
       where r.version_id in (p_prev, p_new) and r.key = ok.key and r.market = v_mkt;
      select array_agg(d order by d) into v_dates
        from (select r.effective_from as d from market.rule_row r where r.version_id in (p_prev, p_new) and r.key = ok.key and r.market = v_mkt
              union
              select r.effective_to from market.rule_row r where r.version_id in (p_prev, p_new) and r.key = ok.key and r.market = v_mkt and r.effective_to is not null) s;
      for i in 1 .. coalesce(array_length(v_dates, 1), 0) loop
        v_from := v_dates[i];
        v_to := case when i < array_length(v_dates, 1) then v_dates[i + 1] end;
        for v_combo in select c from jsonb_array_elements(market.predicate_combinations(nk.predicate_domain, v_attrs)) c loop
          o := market.select_row(p_prev, ok.key, v_mkt, v_combo, v_from);
          if o.id is null then
            continue;
          end if;
          n := market.select_row(p_new, ok.key, v_mkt, v_combo, v_from);
          v_aspects := '{}';
          if n.id is null then
            v_aspects := array['REMOVED'];
          elsif ok.method = 'NOT_COMPARABLE' then
            if n.value <> o.value then v_aspects := array['CHANGED']; end if;
          else
            if not market.at_least_as_strict(ok.method, ok.ordered_values, n.value, o.value) then
              v_aspects := array_append(v_aspects, 'VALUE');
            end if;
            v_ob := market.binding_value(o.floor_type, o.value, o.hard_floor);
            v_nb := market.binding_value(n.floor_type, n.value, n.hard_floor);
            if v_ob is not null and (v_nb is null or not market.at_least_as_strict(ok.method, ok.ordered_values, v_nb, v_ob)) then
              v_aspects := array_append(v_aspects, 'HARD_FLOOR');
            end if;
            if not market.site_loosenable(o.floor_type) and market.site_loosenable(n.floor_type) then
              v_aspects := array_append(v_aspects, 'FLOOR_TYPE');
            end if;
          end if;
          if cardinality(v_aspects) > 0 then
            v_out := v_out || jsonb_build_array(jsonb_build_object(
              'kind', 'LOOSENED', 'key', ok.key, 'market', v_mkt, 'predicate', v_combo, 'aspects', to_jsonb(v_aspects),
              'from', to_char(v_from, 'YYYY-MM-DD'), 'to', to_char(v_to, 'YYYY-MM-DD'), 'oldRow', o.row_ref, 'newRow', n.row_ref,
              'retroactive', v_from <= p_today));
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  return v_out;
end
$$;

-- The change-impact list for a new version: stub MBR limits whose pinned value is looser than the
-- new resolved value, and site values in force that the new version makes inadmissible (looser than
-- a binding value or a DESIGN value, or a loosening that was never approved). Each item is due by the
-- first date on which the new rule applies (today if it already applies).
create function market.compute_change_impact(p_version uuid, p_today date) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  ref        record;
  k          market.rule_key;
  d          date;
  v_res      jsonb;
  a          jsonb;
  v_hit      boolean;
  v_count    integer := 0;
begin
  for ref in
    select 'MBR_LIMIT' as ref_type, m.id, format('%s v%s', m.mbr_code, m.mbr_version) as label, m.key, m.value, m.markets,
           m.predicates, false as approved, null::text as note
      from market.stub_mbr_limit m
     where exists (select 1 from market.rule_key k2 where k2.version_id = p_version and k2.key = m.key)
    union all
    select 'SITE_VALUE', sv.id, format('site %s', sv.site_id), sv.key, sv.value, sv.market_set, sv.predicates,
           sv.outcome = 'LOOSENED', case when sv.outcome = 'LOOSENED' then 'approved loosening ' || sv.justification_ref end
      from (select distinct on (s.site_id, s.key) s.* from market.site_value s
             where s.effective_from <= p_today
             order by s.site_id, s.key, s.effective_from desc, s.recorded_at desc) sv
     where exists (select 1 from market.rule_key k2 where k2.version_id = p_version and k2.key = sv.key)
    order by 1, 3, 4
  loop
    select * into k from market.rule_key where version_id = p_version and key = ref.key;
    a := null;
    if k.method = 'NOT_COMPARABLE' then
      continue;
    end if;
    for d in
      select p_today
      union
      select r.effective_from from market.rule_row r where r.version_id = p_version and r.key = ref.key and r.effective_from > p_today
      order by 1
    loop
      begin
        v_res := market.resolve(p_version, ref.key, ref.markets, ref.predicates, d);
      exception when others then
        insert into market.change_impact (version_id, ref_type, ref_id, ref_label, key, market_set, pinned_value, due_by, problem, note)
        values (p_version, ref.ref_type, ref.id, ref.label, ref.key, ref.markets, ref.value, d, sqlerrm, ref.note);
        v_count := v_count + 1;
        exit;
      end;
      if not (v_res ->> 'applicable')::boolean then
        continue;
      end if;
      if ref.ref_type = 'MBR_LIMIT' then
        v_hit := not coalesce(market.at_least_as_strict(k.method, k.ordered_values, ref.value, v_res -> 'value'), false);
      else
        a := market.assess_site_value(v_res, ref.value);
        v_hit := a ->> 'outcome' = 'REFUSED' or (a ->> 'outcome' = 'LOOSENING' and not ref.approved);
      end if;
      if v_hit then
        insert into market.change_impact (version_id, ref_type, ref_id, ref_label, key, market_set, pinned_value, required_value,
                                          governing_markets, due_by, problem, note)
        values (p_version, ref.ref_type, ref.id, ref.label, ref.key, ref.markets, ref.value, v_res -> 'value',
                array(select jsonb_array_elements_text(v_res -> 'governingMarkets')), d, a ->> 'message', ref.note);
        v_count := v_count + 1;
        exit;
      end if;
    end loop;
  end loop;
  return v_count;
end
$$;

-- Publish a rule-table document as the next version of its table.
-- p_change (merged over the document's "change"): {kind: INITIAL | UPDATE | SOURCE_CORRECTION,
-- description, citation?, approverIds?: [uuid, uuid], vendorNoticeRef?, sourceFile?, sourceSha256?}.
create function market.publish_rule_table(p_doc jsonb, p_change jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_ctx        jsonb := kernel.current_actor();
  v_table      text := p_doc ->> 'table';
  v_first      record;
  v_count      integer;
  v_prev       market.rule_table_version;
  v_has_prev   boolean;
  v_next       integer;
  v_id         uuid := gen_random_uuid();
  v_change     jsonb;
  v_kind       text;
  v_hash       bytea;
  v_today      date;
  v_loose      jsonb := '[]'::jsonb;
  v_retro      jsonb;
  v_approvers  uuid[] := '{}';
  v_impact     integer := 0;
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  select count(*) into v_count from market.validate_document(p_doc);
  if v_count > 0 then
    select * into v_first from market.validate_document(p_doc) limit 1;
    raise exception using errcode = 'P0001', message = v_first.problem_code || ' ' || v_first.problem
      || case when v_count > 1 then format(' (and %s more problems)', v_count - 1) else '' end;
  end if;
  perform pg_advisory_xact_lock(hashtext('market.rule_table:' || v_table));
  select * into v_prev from market.rule_table_version where table_code = v_table order by version desc limit 1;
  v_has_prev := found;
  v_next := case when v_has_prev then v_prev.version + 1 else 1 end;
  if (p_doc ->> 'version')::integer <> v_next then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-012 rule table %s is at version %s, so the next version is %s; the document says %s',
      v_table, coalesce(v_prev.version, 0), v_next, p_doc ->> 'version');
  end if;

  v_change := coalesce(market.nz(p_doc -> 'change', null), '{}'::jsonb) || coalesce(p_change, '{}'::jsonb);
  v_kind := v_change ->> 'kind';
  if coalesce(trim(v_change ->> 'description'), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-033 a rule-table version needs a change description';
  end if;
  if not v_has_prev and v_kind is distinct from 'INITIAL' then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-033 the first version of rule table %s must be INITIAL', v_table);
  end if;
  if v_has_prev and (v_kind is null or v_kind not in ('UPDATE', 'SOURCE_CORRECTION')) then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-033 a later version is an UPDATE or a SOURCE_CORRECTION';
  end if;
  if v_kind = 'SOURCE_CORRECTION' then
    if jsonb_typeof(v_change -> 'approverIds') = 'array' then
      begin
        v_approvers := array(select (a #>> '{}')::uuid from jsonb_array_elements(v_change -> 'approverIds') a);
      exception when others then
        v_approvers := '{}';
      end;
    end if;
    if coalesce(trim(v_change ->> 'citation'), '') = ''
       or cardinality(v_approvers) < 2
       or (select count(distinct a) from unnest(v_approvers) a) <> cardinality(v_approvers)
       or (v_ctx ->> 'person_id')::uuid = any(v_approvers) then
      raise exception using errcode = 'P0001', message =
        'EBMR-MKT-032 a source correction needs a citation and two distinct approvers other than the publisher';
    end if;
  end if;

  insert into market.rule_key (version_id, key, title, method, value_type, unit, ordered_values, stated_method, india_governs,
                               predicate_domain, catalog_refs, description)
  select v_id, k ->> 'key', k ->> 'title', k ->> 'method', k ->> 'valueType', k ->> 'unit', market.nz(k -> 'orderedValues', null),
         k ->> 'statedMethod', (k ->> 'indiaGoverns')::boolean, market.nz(k -> 'predicates', '{}'),
         array(select jsonb_array_elements_text(market.nz(k -> 'catalogRefs', '[]'))), k ->> 'description'
  from jsonb_array_elements(p_doc -> 'keys') k;

  insert into market.rule_row (version_id, row_ref, key, market, predicate, value, unit, floor_type, hard_floor, source, verification,
                               effective_from, effective_to, note, row_hash)
  select v_id, r ->> 'ref', r ->> 'key', r ->> 'market', market.nz(r -> 'predicate', '{}'), r -> 'value', r ->> 'unit', r ->> 'floor',
         market.nz(r -> 'hardFloor', null), r ->> 'source', r ->> 'verification', (r ->> 'effectiveFrom')::date,
         (market.nz(r -> 'effectiveTo', null) #>> '{}')::date, r ->> 'note',
         sha256(convert_to(market.canonical_row(r)::text, 'UTF8'))
  from jsonb_array_elements(p_doc -> 'rows') r;

  v_hash := market.document_content_hash(p_doc);
  if v_has_prev and v_hash = v_prev.content_hash then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-030 the document is identical to rule table %s version %s; nothing to publish', v_table, v_prev.version);
  end if;

  v_today := (clock_timestamp() at time zone coalesce(v_ctx ->> 'site_zone', 'UTC'))::date;
  if v_has_prev then
    v_loose := market.classify_changes(v_prev.id, v_id, v_today);
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_retro from jsonb_array_elements(v_loose) x where (x ->> 'retroactive')::boolean;
    if v_kind = 'UPDATE' and jsonb_array_length(v_retro) > 0 then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-031 this version loosens or removes values that are already in force (first: %s); only a SOURCE_CORRECTION may do that',
        (v_retro -> 0)::text);
    end if;
  end if;

  insert into market.rule_table_version (id, table_code, version, content_hash, change_kind, change_description, citation, approver_ids,
                                         vendor_notice_ref, loosening, source_file, source_sha256, previous_version_id, key_count,
                                         row_count, published_by)
  values (v_id, v_table, v_next, v_hash, v_kind, trim(v_change ->> 'description'), nullif(trim(v_change ->> 'citation'), ''), v_approvers,
          nullif(trim(v_change ->> 'vendorNoticeRef'), ''), v_loose, v_change ->> 'sourceFile', v_change ->> 'sourceSha256',
          case when v_has_prev then v_prev.id end,
          jsonb_array_length(p_doc -> 'keys'), jsonb_array_length(p_doc -> 'rows'), (v_ctx ->> 'person_id')::uuid);

  -- The stored version must reproduce the document exactly.
  if market.document_content_hash(market.version_document(v_id)) <> v_hash then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-034 internal error: the stored version does not reproduce the document';
  end if;

  perform kernel.audit_business_event('market_rule_table:' || v_table,
    format('rule table %s version %s published (%s): %s', v_table, v_next, v_kind, trim(v_change ->> 'description')),
    jsonb_build_object('versionId', v_id, 'contentHash', encode(v_hash, 'hex'), 'loosening', v_loose));

  v_impact := market.compute_change_impact(v_id, v_today);

  return jsonb_build_object('versionId', v_id, 'table', v_table, 'version', v_next, 'contentHash', encode(v_hash, 'hex'),
                            'changeKind', v_kind, 'loosening', v_loose, 'impactCount', v_impact);
end
$$;

-- Recompute a version's content hash and row hashes and re-validate its content.
create function market.verify_table_version(p_version uuid) returns table (problem text)
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v market.rule_table_version;
  r record;
  x record;
begin
  select * into v from market.rule_table_version where id = p_version;
  if not found then
    problem := 'version not found'; return next; return;
  end if;
  if market.document_content_hash(market.version_document(p_version)) <> v.content_hash then
    problem := 'content hash does not match the stored keys and rows (version altered)'; return next;
  end if;
  for r in
    select rr.row_ref from market.rule_row rr
    where rr.version_id = p_version
      and rr.row_hash <> sha256(convert_to(market.canonical_row(jsonb_build_object(
            'ref', rr.row_ref, 'key', rr.key, 'market', rr.market, 'predicate', rr.predicate, 'value', rr.value, 'unit', rr.unit,
            'floor', rr.floor_type, 'hardFloor', rr.hard_floor, 'source', rr.source, 'verification', rr.verification,
            'effectiveFrom', to_char(rr.effective_from, 'YYYY-MM-DD'), 'effectiveTo', to_char(rr.effective_to, 'YYYY-MM-DD'),
            'note', rr.note))::text, 'UTF8'))
    order by 1
  loop
    problem := format('row %s: hash does not match its content (row altered)', r.row_ref); return next;
  end loop;
  for x in select * from market.validate_document(market.version_document(p_version)) loop
    problem := x.problem_code || ' ' || x.problem; return next;
  end loop;
end
$$;

select kernel.register_audited_table('market.change_impact', 'market_rule_version', 'version_id', true);

grant select on market.change_impact to ebmr_app;
grant execute on function market.publish_rule_table(jsonb, jsonb), market.verify_table_version(uuid) to ebmr_app;

reset role;
