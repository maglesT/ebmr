-- Recipe core: the product quality review (PQR/APR) extract (Phase 4 slice 6c; controls IN-01 (b) and PR-58; plan
-- docs/build-plan/phase-4/phase-4-plan.md slice 6, defaults D-P4-8, D-6-7 and D-6c-1 to D-6c-6).
--
-- The extract is a versioned SQL query. recipe.pqr_query_version holds each version: the query function and the SHA-256
-- of its definition (pg_get_functiondef) taken when the version was installed; a run refuses a query whose definition no
-- longer matches its version (a changed query is a new version, never an edit). Version 1 is recipe.pqr_extract_v1.
--
-- recipe.pqr_extract_v1(product, from, to) (STABLE, no clock): for one product (the code in the issued master) and a
-- period of issue dates (inclusive, each batch's own site zone), every GMP batch, processing and packaging, domestic and
-- export-only (every batch is made under the Indian licence, INV-28, so an export-only SKU is a finished lot whose market
-- set leaves out IN, and a batch is export-only when it has lots and every one is; D-6c-2), failed ones included (aborted or cancelled, or a finished lot
-- rejected, rejected after release or recalled), each with its finished lots and their manufacturer release and market
-- states, its market removals (recipe.market_change REMOVE on the batch or its lots) and the change record its master
-- version was made under; the deviation-lite records linked to them with state, classification and CAPA as recorded on
-- the closure basis (D-6-7: no separate CAPA register yet); the change records (the batches' masters, the market adds
-- of the batches and lots, and the product's master versions effective in the period); and the counts. Every array is
-- ordered, so the same data gives the same jsonb text and the same SHA-256 (D-P4-8).
--
-- Reconciliation (IN-01, PR-58; D-6-7). recipe.pqr_register_view(product, from, to) reads the same period through the
-- registers instead of the records: the batch number register (site.batch_number_allocation of the product, not voided,
-- through its link to the issued batch), the deviation register by the batch numbers and finished lots it names, and the
-- change records through the batches' master pins. recipe.pqr_reconciliation(result, registers) compares the batch
-- numbers, deviations and change records both ways; any difference fails the extract (EBMR-PQR-006): nothing is stored.
--
-- Acts (SECURITY DEFINER, never an administrator, the permission first):
--   recipe.run_pqr_extract(product, from, to)    PQR.EXTRACT (QA reviewer, head of QC, AP): one insert-only row with the
--       query version, the parameters, the result, its SHA-256 and the reconciliation. A re-run on the same data gives
--       the same hash; recipe.pqr_reproduces(extract) re-runs it and says whether it still does.
--   recipe.sign_off_pqr(extract, signature)      PQR.SIGN_OFF (the AP only): PQR_SIGNED_OFF on pqr_extract <extract id>,
--       the signer's own signature as AUTHORISED_PERSON on the current content, the signer outside the involvement set of
--       the extract's batches (INV-35 by analogy), the extract still reproducing (the same hash and a clean
--       reconciliation now; else run it again), once per extract.
-- Messages: EBMR-PQR-001 to EBMR-PQR-029.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0910_pqr_extract)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'product quality review extract, reconciliation and the authorised person''s sign-off (IN-01, PR-58)'));

insert into iam.permission (code, domain, effect, description) values
  ('PQR.EXTRACT', 'GMP', 'WRITE', 'Run the product quality review extract for a product and period (IN-01, PR-58)'),
  ('PQR.SIGN_OFF', 'GMP', 'SIGN', 'Sign off a product quality review extract as the authorised person (IN-01 (b))');
insert into iam.role_permission (role_code, permission_code) values
  ('QA_REVIEWER', 'PQR.EXTRACT'), ('HEAD_OF_QC', 'PQR.EXTRACT'), ('AUTHORISED_PERSON', 'PQR.EXTRACT'),
  ('AUTHORISED_PERSON', 'PQR.SIGN_OFF');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('PQR_SIGNED_OFF', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'APPROVER', 'Product quality review signed off',
   'As the authorised person, I sign off this product quality review extract for the product and period stated: it reconciles to the registers.',
   array['PQR.SIGN_OFF'], '{}', true, true, false, 'ALL_COMPONENTS', false, 'IN-01 (b); PR-58; D-P4-8');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited)
-- ---------------------------------------------------------------------------------------------

create table recipe.pqr_query_version (
  version            integer primary key check (version >= 1),
  query_function     text not null unique,
  definition_sha256  text not null check (definition_sha256 ~ '^[0-9a-f]{64}$'),
  description        text not null check (btrim(description) <> ''),
  recorded_at        timestamptz not null default clock_timestamp()
);

create table recipe.pqr_extract (
  id              uuid primary key default gen_random_uuid(),
  product_code    text not null check (product_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  period_from     date not null,
  period_to       date not null,
  query_version   integer not null references recipe.pqr_query_version (version),
  parameters      jsonb not null check (jsonb_typeof(parameters) = 'object'),
  result          jsonb not null check (jsonb_typeof(result) = 'object'),
  result_sha256   text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  reconciliation  jsonb not null check (jsonb_typeof(reconciliation) = 'object'),
  person_id       uuid not null,
  account_id      uuid not null,
  role_code       text not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  check (period_from <= period_to)
);
create index pqr_extract_product on recipe.pqr_extract (product_code, period_from, period_to, recorded_at);

create table recipe.pqr_signoff (
  id              uuid primary key default gen_random_uuid(),
  extract_id      uuid not null unique references recipe.pqr_extract (id),
  result_sha256   text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  signature_id    uuid not null unique,
  content_hash    text not null,
  person_id       uuid not null,
  account_id      uuid not null,
  role_code       text not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);

revoke all on recipe.pqr_query_version, recipe.pqr_extract, recipe.pqr_signoff from public;
grant select on recipe.pqr_query_version, recipe.pqr_extract, recipe.pqr_signoff to ebmr_app;

select kernel.register_audited_table('recipe.pqr_query_version', 'pqr_query', 'version', true);
select kernel.register_audited_table('recipe.pqr_extract', 'pqr_extract', 'id', true);
select kernel.register_audited_table('recipe.pqr_signoff', 'pqr_extract', 'extract_id', true);

-- ---------------------------------------------------------------------------------------------
-- The query, version 1
-- ---------------------------------------------------------------------------------------------

create function recipe.pqr_extract_v1(p_product text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with bx as (
    select b.id, b.batch_number, b.site_code, sb.markets as markets, sb.family_id, (b.issued_at at time zone b.site_zone)::date as issued_on
      from recipe.batch_execution b join recipe.stub_batch sb on sb.id = b.id
     where b.installation = 'GMP' and b.purpose = 'GMP_BATCH'
       and recipe.batch_product(b.id) ->> 'code' = p_product
       and (b.issued_at at time zone b.site_zone)::date between p_from and p_to),
  lots as (
    select f.lot_id, f.batch_id, l.lot_code, f.markets, recipe.manufacturer_release_state(f.lot_id) as release_state
      from site.finished_lot f join site.material_lot l on l.id = f.lot_id join bx on bx.id = f.batch_id),
  removals as (
    select m.*, coalesce(case when m.subject_kind = 'BATCH' then m.subject_id end, (select x.batch_id from lots x where x.lot_id = m.subject_id)) as batch_id
      from recipe.market_change m
     where m.change = 'REMOVE'
       and ((m.subject_kind = 'BATCH' and m.subject_id in (select id from bx)) or (m.subject_kind = 'LOT' and m.subject_id in (select lot_id from lots)))),
  devs as (
    select distinct y.deviation_id, coalesce(y.batch_id, (select x.batch_id from lots x where x.lot_id = y.subject_id)) as batch_id
      from site.deviation_link y
     where y.batch_id in (select id from bx) or (y.subject_kind = 'LOT' and y.subject_id in (select lot_id from lots))),
  dev_rows as (
    select d.id, d.ref, d.kind, d.title,
           coalesce((select c.classification from site.deviation_classification c where c.deviation_id = d.id order by c.seq desc limit 1), d.classification) as classification,
           site.deviation_state(d.id) as state,
           (select cb from site.deviation_closure_basis cb where cb.deviation_id = d.id order by cb.seq desc limit 1) as basis,
           (select array_agg(distinct bx.batch_number order by bx.batch_number) from devs x join bx on bx.id = x.batch_id where x.deviation_id = d.id) as batches
      from site.deviation d where d.id in (select deviation_id from devs)),
  changes as (
    select cr.id from recipe.batch_execution b join recipe.control_recipe c on c.id = b.control_recipe_id
      join recipe.mbr_version v on v.id = c.version_id join recipe.change_record cr on cr.id = v.change_record_id
     where b.id in (select id from bx)
    union
    select m.change_record_id from recipe.market_change m
     where m.change = 'ADD' and ((m.subject_kind = 'BATCH' and m.subject_id in (select id from bx)) or (m.subject_kind = 'LOT' and m.subject_id in (select lot_id from lots)))
    union
    select v.change_record_id from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id
     where f.product_code = p_product and v.change_record_id is not null and (v.effective_from at time zone 'UTC')::date between p_from and p_to),
  batch_rows as (
    select bx.*, fam.record_kind, recipe.batch_purpose(bx.id) as purpose, s.status as status,
           (exists (select 1 from lots x where x.batch_id = bx.id) and not exists (select 1 from lots x where x.batch_id = bx.id and 'IN' = any (x.markets))) as export_only,
           coalesce((select jsonb_agg(jsonb_build_object('lot_id', x.lot_id, 'lot_code', x.lot_code,
                                                         'markets', to_jsonb(array(select unnest(x.markets) order by 1)), 'export_only', not ('IN' = any (x.markets)),
                                                         'manufacturer_release', x.release_state,
                                                         'markets_state', (select jsonb_object_agg(mk, recipe.disposition_state(x.lot_id, mk)) from unnest(x.markets) mk where mk <> 'IN'))
                                      order by x.lot_code, x.lot_id) from lots x where x.batch_id = bx.id), '[]'::jsonb) as lots,
           coalesce((select jsonb_agg(jsonb_build_object('market', r.market, 'subject_kind', r.subject_kind, 'subject_id', r.subject_id, 'sequence', r.seq,
                                                         'deviation_id', r.deviation_id, 'removed_after_failure', r.removed_after_failure)
                                      order by r.market, r.subject_kind, r.subject_id, r.seq) from removals r where r.batch_id = bx.id), '[]'::jsonb) as removals,
           (select cr.number from recipe.control_recipe c join recipe.mbr_version v on v.id = c.version_id join recipe.change_record cr on cr.id = v.change_record_id
             where c.id = (select b.control_recipe_id from recipe.batch_execution b where b.id = bx.id)) as change_record,
           (s.status in ('ABORTED', 'CANCELLED')
            or exists (select 1 from lots x where x.batch_id = bx.id and x.release_state in ('REJECTED', 'REJECTED_AFTER_RELEASE', 'RECALLED'))) as failed
      from bx join recipe.mbr_family fam on fam.id = bx.family_id left join recipe.execution_state s on s.batch_id = bx.id)
  select jsonb_build_object(
    'query_version', 1,
    'product_code', p_product,
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'batches', coalesce((select jsonb_agg(jsonb_build_object(
                  'batch_id', r.id, 'batch_number', r.batch_number, 'site_code', r.site_code, 'record_kind', r.record_kind, 'purpose', r.purpose,
                  'issued_on', r.issued_on, 'status', r.status, 'markets', to_jsonb(array(select unnest(r.markets) order by 1)), 'export_only', r.export_only,
                  'failed', r.failed, 'lots', r.lots, 'market_removals', r.removals, 'change_record', r.change_record,
                  'deviations', coalesce((select jsonb_agg(d.ref order by d.ref) from dev_rows d join devs x on x.deviation_id = d.id where x.batch_id = r.id), '[]'::jsonb))
                order by r.batch_number, r.id) from batch_rows r), '[]'::jsonb),
    'deviations', coalesce((select jsonb_agg(jsonb_build_object(
                  'deviation_id', d.id, 'ref', d.ref, 'kind', d.kind, 'title', d.title, 'classification', d.classification, 'state', d.state,
                  'capa_refs', to_jsonb(coalesce(array(select unnest((d.basis).capa_refs) order by 1), '{}'::text[])), 'no_capa_reason', (d.basis).no_capa_reason,
                  'batches', to_jsonb(coalesce(d.batches, '{}'::text[])))
                order by d.ref) from dev_rows d), '[]'::jsonb),
    'changes', coalesce((select jsonb_agg(jsonb_build_object('change_record_id', cr.id, 'number', cr.number, 'title', cr.title, 'change_class', cr.change_class)
                order by cr.number) from recipe.change_record cr where cr.id in (select id from changes)), '[]'::jsonb),
    'counts', jsonb_build_object(
      'batches', (select count(*) from batch_rows),
      'export_only_batches', (select count(*) from batch_rows where export_only),
      'failed_batches', (select count(*) from batch_rows where failed),
      'lots', (select count(*) from lots),
      'export_only_lots', (select count(*) from lots where not ('IN' = any (markets))),
      'market_removals', (select count(*) from removals),
      'deviations', (select count(*) from dev_rows),
      'deviations_with_capa', (select count(*) from dev_rows d where cardinality(coalesce((d.basis).capa_refs, '{}')) > 0),
      'changes', (select count(*) from changes)))
$$;

-- ---------------------------------------------------------------------------------------------
-- The registers and the reconciliation
-- ---------------------------------------------------------------------------------------------

-- The same product and period read through the registers: the batch number register's entries of the product (not
-- voided) linked to a GMP batch issued in the period; the deviations linked by those batch numbers or to finished lots
-- posted under them; the change records of the masters those batches were pinned to and of the market adds.
create function recipe.pqr_register_view(p_product text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with reg as (
    select a.batch_number, k.batch_id from site.batch_number_allocation a
      join recipe.batch_allocation_link k on k.allocation_id = a.id
      join recipe.batch_execution b on b.id = k.batch_id
     where a.product_code = p_product and not exists (select 1 from site.batch_number_void v where v.allocation_id = a.id)
       and b.installation = 'GMP' and (b.issued_at at time zone b.site_zone)::date between p_from and p_to),
  lots as (select f.lot_id from site.finished_lot f where f.batch_number in (select batch_number from reg)),
  devs as (
    select distinct y.deviation_id from site.deviation_link y
     where y.batch_number in (select batch_number from reg) or (y.subject_kind = 'LOT' and y.subject_id in (select lot_id from lots))),
  changes as (
    select v.change_record_id as id from recipe.batch_mbr_pin p join recipe.mbr_version v on v.id = p.version_id
     where p.batch_id in (select batch_id from reg) and v.change_record_id is not null
    union
    select m.change_record_id from recipe.market_change m
     where m.change = 'ADD' and ((m.subject_kind = 'BATCH' and m.subject_id in (select batch_id from reg)) or (m.subject_kind = 'LOT' and m.subject_id in (select lot_id from lots)))
    union
    select v.change_record_id from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id
     where f.product_code = p_product and v.change_record_id is not null and (v.effective_from at time zone 'UTC')::date between p_from and p_to)
  select jsonb_build_object(
    'batches', to_jsonb(coalesce((select array_agg(batch_number order by batch_number) from reg), '{}'::text[])),
    'deviations', to_jsonb(coalesce((select array_agg(d.ref order by d.ref) from site.deviation d where d.id in (select deviation_id from devs)), '{}'::text[])),
    'changes', to_jsonb(coalesce((select array_agg(c.number order by c.number) from recipe.change_record c where c.id in (select id from changes)), '{}'::text[])))
$$;

-- IN-01, PR-58: the extract's counts against the registers, both ways. {ok, problems[], batches|deviations|changes:
-- {extract, register, missing_from_extract[], missing_from_register[]}}.
create function recipe.pqr_reconciliation(p_result jsonb, p_register jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_out   jsonb := '{}'::jsonb;
  v_probs text[] := '{}';
  k       text;
  e       text[];
  r       text[];
  a       text[];
  b       text[];
begin
  foreach k in array array['batches', 'deviations', 'changes'] loop
    e := case k
           when 'batches' then array(select x ->> 'batch_number' from jsonb_array_elements(p_result -> 'batches') x order by 1)
           when 'deviations' then array(select x ->> 'ref' from jsonb_array_elements(p_result -> 'deviations') x order by 1)
           else array(select x ->> 'number' from jsonb_array_elements(p_result -> 'changes') x order by 1) end;
    r := array(select x from jsonb_array_elements_text(p_register -> k) x order by 1);
    a := array(select x from unnest(r) x except select y from unnest(e) y order by 1);
    b := array(select x from unnest(e) x except select y from unnest(r) y order by 1);
    v_out := v_out || jsonb_build_object(k, jsonb_build_object('extract', cardinality(e), 'register', cardinality(r),
                                                               'missing_from_extract', to_jsonb(a), 'missing_from_register', to_jsonb(b)));
    if cardinality(e) <> cardinality(r) or cardinality(a) > 0 or cardinality(b) > 0 then
      v_probs := v_probs || format('%s: %s in the extract, %s in the register%s%s', k, cardinality(e), cardinality(r),
                                   case when cardinality(a) > 0 then '; in the register only: ' || array_to_string(a, ', ') else '' end,
                                   case when cardinality(b) > 0 then '; in the extract only: ' || array_to_string(b, ', ') else '' end);
    end if;
  end loop;
  return v_out || jsonb_build_object('ok', cardinality(v_probs) = 0, 'problems', to_jsonb(v_probs));
end
$$;

-- The query version in force and whether its definition is still the one installed with it; NULL when it is.
create function recipe.pqr_query_problem(p_version integer) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when q.version is null then format('there is no PQR query version %s', coalesce(p_version::text, 'NULL'))
    when to_regprocedure(q.query_function) is null then format('the query of PQR version %s (%s) is not installed', q.version, q.query_function)
    when encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(q.query_function)), 'UTF8')), 'hex') <> q.definition_sha256
      then format('the query of PQR version %s changed after it was installed; a changed query is a new version (D-P4-8)', q.version)
  end
  from (select p_version as v) x left join recipe.pqr_query_version q on q.version = x.v
$$;

create function recipe.pqr_result_sha256(p_result jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(p_result::text, 'UTF8')), 'hex')
$$;

-- The current query version (the highest).
create function recipe.pqr_current_version() returns integer
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select max(version) from recipe.pqr_query_version
$$;

-- Run query version p_version (version 1 only so far).
create function recipe.pqr_run_query(p_version integer, p_product text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_prob text := recipe.pqr_query_problem(p_version);
begin
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PQR-004 %s', v_prob);
  end if;
  if p_version = 1 then
    return recipe.pqr_extract_v1(p_product, p_from, p_to);
  end if;
  raise exception using errcode = 'P0001', message = format('EBMR-PQR-004 PQR query version %s is not runnable here', p_version);
end
$$;

-- Whether extract p_extract still reproduces: the same query version on the same parameters gives the same SHA-256.
create function recipe.pqr_reproduces(p_extract uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select recipe.pqr_result_sha256(recipe.pqr_run_query(x.query_version, x.product_code, x.period_from, x.period_to)) = x.result_sha256
    from recipe.pqr_extract x where x.id = p_extract
$$;

-- Everyone involved in the records of the extract's batches (performers, approvers, other signers).
create function recipe.pqr_involvement(p_extract uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct p order by p), '{}')
    from recipe.pqr_extract x, jsonb_array_elements(x.result -> 'batches') b, unnest(recipe.batch_involvement((b ->> 'batch_id')::uuid)) p
   where x.id = p_extract
$$;

-- ---------------------------------------------------------------------------------------------
-- Run
-- ---------------------------------------------------------------------------------------------

create function recipe.run_pqr_extract(p_product text, p_from date, p_to date) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor   jsonb;
  v_version integer;
  v_result  jsonb;
  v_reg     jsonb;
  v_rec     jsonb;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  if p_product is null or p_product !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$' then
    raise exception using errcode = 'P0001', message = format('EBMR-PQR-001 %s is not a product code', coalesce(p_product, 'NULL'));
  end if;
  v_actor := iam.require_permission('PQR.EXTRACT', jsonb_build_object('product', p_product));
  if p_from is null or p_to is null or p_from > p_to then
    raise exception using errcode = 'P0001', message = 'EBMR-PQR-002 the period runs from a first day to a last day on or after it';
  end if;
  if p_to > p_from + interval '3 years' then
    raise exception using errcode = 'P0001', message = 'EBMR-PQR-003 a review period is at most three years (normally twelve months; IN-01)';
  end if;
  v_version := recipe.pqr_current_version();
  v_result := recipe.pqr_run_query(v_version, p_product, p_from, p_to);
  v_reg := recipe.pqr_register_view(p_product, p_from, p_to);
  v_rec := recipe.pqr_reconciliation(v_result, v_reg);
  if not (v_rec ->> 'ok')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PQR-006 the extract for %s, %s to %s, does not reconcile to the registers: %s; nothing is stored (IN-01, PR-58)',
                       p_product, p_from, p_to, array_to_string(array(select jsonb_array_elements_text(v_rec -> 'problems')), '; '));
  end if;
  insert into recipe.pqr_extract (product_code, period_from, period_to, query_version, parameters, result, result_sha256, reconciliation,
                                  person_id, account_id, role_code, correlation_id)
  values (p_product, p_from, p_to, v_version, jsonb_build_object('product_code', p_product, 'from', p_from, 'to', p_to), v_result,
          recipe.pqr_result_sha256(v_result), v_rec, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code',
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Sign-off
-- ---------------------------------------------------------------------------------------------

create function recipe.pqr_extract_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x recipe.pqr_extract;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into x from recipe.pqr_extract where id = p_id::uuid;
  if x.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'state', case when exists (select 1 from recipe.pqr_signoff s where s.extract_id = x.id) then 'SIGNED_OFF' else 'EXTRACTED' end,
    'content', jsonb_build_object('extract_id', x.id, 'product_code', x.product_code, 'period_from', x.period_from, 'period_to', x.period_to,
                                  'query_version', x.query_version, 'result_sha256', x.result_sha256, 'counts', x.result -> 'counts',
                                  'reconciliation', x.reconciliation),
    'scope', jsonb_build_object('product', x.product_code),
    'involved', to_jsonb(recipe.pqr_involvement(x.id)));
end
$$;

select esig.register_content_provider('pqr_extract', 'recipe.pqr_extract_content(text)',
  'A product quality review extract for a product and period, signed off by the authorised person (IN-01, PR-58)');

create function recipe.sign_off_pqr(p_extract uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, pg_temp as $$
declare
  v_actor   jsonb;
  x         recipe.pqr_extract;
  v_now     jsonb;
  v_rec     jsonb;
  v_sig     jsonb;
  v_role    text;
  v_content text;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  select * into x from recipe.pqr_extract where id = p_extract;
  if x.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PQR-010 there is no PQR extract %s', coalesce(p_extract::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('PQR.SIGN_OFF', jsonb_build_object('product', x.product_code));
  perform 1 from recipe.pqr_extract where id = x.id for update;
  if exists (select 1 from recipe.pqr_signoff s where s.extract_id = x.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-PQR-011 this extract is signed off already';
  end if;
  -- PR-58: the extract still reproduces on the data as it stands, and still reconciles.
  v_now := recipe.pqr_run_query(x.query_version, x.product_code, x.period_from, x.period_to);
  if recipe.pqr_result_sha256(v_now) <> x.result_sha256 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-PQR-012 the records changed after the extract was run (its SHA-256 differs now); run the extract again and sign that one (PR-58, D-P4-8)';
  end if;
  v_rec := recipe.pqr_reconciliation(v_now, recipe.pqr_register_view(x.product_code, x.period_from, x.period_to));
  if not (v_rec ->> 'ok')::boolean then
    raise exception using errcode = 'P0001', message = 'EBMR-PQR-006 the extract no longer reconciles to the registers; nothing is signed (IN-01, PR-58)';
  end if;
  v_sig := recipe.assert_release_signature(p_signature, 'PQR_SIGNED_OFF', 'pqr_extract', x.id::text, (v_actor ->> 'person_id')::uuid);
  select s.signer_role_code into v_role from esig.signature s where s.id = p_signature;
  if v_role is distinct from 'AUTHORISED_PERSON' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PQR-013 a PQR is signed off by the authorised person, not as %s (IN-01 (b))', coalesce(v_role, 'no role'));
  end if;
  if (v_actor ->> 'person_id')::uuid = any (recipe.pqr_involvement(x.id)) then
    raise exception using errcode = 'P0001', message = 'EBMR-PQR-014 a person involved in the records of the reviewed batches never signs off their quality review (INV-35)';
  end if;
  v_content := esig.content_hash_of('pqr_extract', x.id::text, esig.provide('pqr_extract', x.id::text));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-PQR-015 the signed extract is not the current one; sign it again (DI-37)';
  end if;
  insert into recipe.pqr_signoff (extract_id, result_sha256, signature_id, content_hash, person_id, account_id, role_code, correlation_id)
  values (x.id, x.result_sha256, p_signature, v_content, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_role,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function recipe.pqr_extract_v1(text, date, date), recipe.pqr_register_view(text, date, date),
  recipe.pqr_reconciliation(jsonb, jsonb), recipe.pqr_query_problem(integer), recipe.pqr_result_sha256(jsonb), recipe.pqr_current_version(),
  recipe.pqr_run_query(integer, text, date, date), recipe.pqr_reproduces(uuid), recipe.pqr_involvement(uuid), recipe.run_pqr_extract(text, date, date),
  recipe.pqr_extract_content(text), recipe.sign_off_pqr(uuid, uuid) from public;
grant execute on function recipe.pqr_query_problem(integer), recipe.pqr_result_sha256(jsonb), recipe.pqr_current_version(), recipe.pqr_reproduces(uuid),
  recipe.pqr_involvement(uuid), recipe.run_pqr_extract(text, date, date), recipe.sign_off_pqr(uuid, uuid) to ebmr_app;

-- Version 1, with the SHA-256 of its definition as installed (D-P4-8).
select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0910_pqr_extract)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'PQR extract query version 1 (D-P4-8)'));
insert into recipe.pqr_query_version (version, query_function, definition_sha256, description)
values (1, 'recipe.pqr_extract_v1(text,date,date)',
        encode(sha256(convert_to(pg_get_functiondef('recipe.pqr_extract_v1(text,date,date)'::regprocedure), 'UTF8')), 'hex'),
        'Batches (domestic and export-only, failed included) with lots, release and market states and market removals; deviations with CAPA as recorded; change records; counts');
select kernel.set_actor_context(null);

reset role;
