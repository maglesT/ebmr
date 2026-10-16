-- Recipe core: the mock recall, the deviation impact query and the deviation recurrence count (Phase 6 slice 6d;
-- controls IN-29, PR-57, PR-50, PR-49; plan "Slice 6d", defaults D-P6d-2, D-P6d-3, D-P6d-0-3, D-P6d-0-7, D-P6d-0-8 and
-- D-P6d-1 to D-P6d-6 of the build in docs/build-plan/phase-6/phase-6-plan.md).
--
-- Handbook: modules/recipe-core.md
--
-- The mock recall (IN-29; D-P6d-2: a stored exercise the AP signs off; it never changes a lot).
--   recipe.mock_recall_result_v1(subject kind, subject id, as_of) jsonb (STABLE): from a lot, or from a deviation (each of
--       its links recorded by then), the forward genealogy (recipe.genealogy, 1010) as of the instant: the affected
--       batches and lots with their depth, a reconciliation line per lot (delivered: its shipments in the lot's unit;
--       returned: its returned goods; outstanding = delivered - returned), the consignees with their shipments, and the
--       shipment numbers whose record lacks the consignee's address or uses another unit (incomplete, D-P6d-0-7). Every
--       array is ordered and every quantity is decimal text, so the same rows give the same jsonb text and SHA-256.
--   recipe.run_mock_recall(kind, id, as_of, authority informed, reference) uuid   RECALL.MOCK_RUN (QA reviewer, head of
--       QC, AP): the as-of point (now by default, never in the future), the query version, the result and its SHA-256, and
--       whether the licensing authority was informed of the intended recall (a reference when it was), in one
--       insert-only row. recipe.mock_recall_reproduces(id) re-runs it as of the same instant.
--   recipe.sign_off_mock_recall(id, signature) uuid   RECALL.MOCK_SIGN_OFF (the AP only, D-P6d-0-8): MOCK_RECALL_SIGNED_OFF
--       on mock_recall <id>, the signer's own signature as AUTHORISED_PERSON on the current content, the run still
--       reproducing, once.
-- The deviation impact query (PR-50; D-P6d-4):
--   recipe.deviation_impact_batches(deviation, as_of) setof (batch_id, batch_number, product_code, relation): LINKED (the
--       batches the deviation's links name, and the batch of a linked finished lot), DOWNSTREAM (every batch forward of a
--       linked subject), SHARED_LOT (every batch that consumed a lot a LINKED batch consumed, and every batch forward of
--       one); each batch once, under the first relation in that order. Equipment, rooms, people and time windows are
--       the investigation's assessment of other batches (closure basis, 0820), not this query.
-- The recurrence count (PR-49; D-P6d-5):
--   recipe.deviation_recurrence(lot) jsonb: for each deviation of the lot (recipe.release_deviations), the deviations of
--       the same product (by their linked batches or finished lots) whose latest finding has the same root-cause category,
--       raised in the 365 days up to now, this one included; a warning from the third (threshold 3). A deviation with no
--       finding yet, or NOT_DETERMINED, is not counted.
--
-- Messages: EBMR-RCL-001 to EBMR-RCL-019.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1012_mock_recall_impact_recurrence)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'mock recall and the authorised person''s sign-off (IN-29, PR-57)'));

insert into iam.permission (code, domain, effect, description) values
  ('RECALL.MOCK_RUN', 'GMP', 'WRITE', 'Run a mock recall from a lot or a deviation as of an instant (IN-29, PR-57)'),
  ('RECALL.MOCK_SIGN_OFF', 'GMP', 'SIGN', 'Sign off a mock recall as the authorised person who owns recall execution (IN-29)');
insert into iam.role_permission (role_code, permission_code) values
  ('QA_REVIEWER', 'RECALL.MOCK_RUN'), ('HEAD_OF_QC', 'RECALL.MOCK_RUN'), ('AUTHORISED_PERSON', 'RECALL.MOCK_RUN'),
  ('AUTHORISED_PERSON', 'RECALL.MOCK_SIGN_OFF');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('MOCK_RECALL_SIGNED_OFF', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'APPROVER', 'Mock recall signed off',
   'As the authorised person who owns recall execution, I sign off this mock recall: the affected batches, lots and consignees and the reconciliation of delivered against returned quantities as stated.',
   array['RECALL.MOCK_SIGN_OFF'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'IN-29; PR-57; D-P6d-2');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited)
-- ---------------------------------------------------------------------------------------------

create table recipe.mock_recall (
  id                   uuid primary key default gen_random_uuid(),
  subject_kind         text not null check (subject_kind in ('LOT', 'DEVIATION')),
  subject_id           uuid not null,
  subject_ref          text not null check (btrim(subject_ref) <> ''),
  as_of                timestamptz not null,
  query_version        integer not null check (query_version >= 1),
  result               jsonb not null check (jsonb_typeof(result) = 'object'),
  result_sha256        text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  authority_informed   boolean not null,
  authority_reference  text check (authority_reference is null or (btrim(authority_reference) <> '' and length(authority_reference) <= 200)),
  person_id            uuid not null,
  account_id           uuid not null,
  role_code            text not null,
  correlation_id       uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  check (not authority_informed or authority_reference is not null),
  check (as_of <= recorded_at)
);
create index mock_recall_recorded on recipe.mock_recall (recorded_at);

create table recipe.mock_recall_signoff (
  id              uuid primary key default gen_random_uuid(),
  mock_recall_id  uuid not null unique references recipe.mock_recall (id),
  result_sha256   text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  signature_id    uuid not null unique,
  content_hash    text not null,
  person_id       uuid not null,
  account_id      uuid not null,
  role_code       text not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);

revoke all on recipe.mock_recall, recipe.mock_recall_signoff from public;
grant select on recipe.mock_recall, recipe.mock_recall_signoff to ebmr_app;
create trigger aa_insert_only before update or delete on recipe.mock_recall for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.mock_recall for each statement execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on recipe.mock_recall_signoff for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.mock_recall_signoff for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('recipe.mock_recall', array['recorded_at']);
select platform.enforce_db_time('recipe.mock_recall_signoff', array['recorded_at']);
select kernel.register_audited_table('recipe.mock_recall', 'mock_recall', 'id', true);
select kernel.register_audited_table('recipe.mock_recall_signoff', 'mock_recall', 'mock_recall_id', true);

-- ---------------------------------------------------------------------------------------------
-- Shared reads
-- ---------------------------------------------------------------------------------------------

-- The batch number of a batch (issued or planned).
create function recipe.genealogy_batch_number(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select b.batch_number from recipe.batch_execution b where b.id = p_batch),
                  (select l.batch_number from recipe.batch_allocation_link l where l.batch_id = p_batch))
$$;

-- The start nodes of a subject as of an instant: the lot itself, or each subject a deviation linked by then.
create function recipe.mock_recall_starts(p_kind text, p_id uuid, p_as_of timestamptz) returns table (kind text, id uuid)
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select 'LOT'::text, p_id where p_kind = 'LOT'
  union
  select y.subject_kind, y.subject_id from site.deviation_link y where p_kind = 'DEVIATION' and y.deviation_id = p_id and y.linked_at <= p_as_of
$$;

-- Every node forward of the starts, with its fewest steps from any of them.
create function recipe.genealogy_forward_set(p_kinds text[], p_ids uuid[], p_as_of timestamptz) returns table (kind text, id uuid, depth integer)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select g.node_kind, g.node_id, min(g.depth)::integer
    from unnest(p_kinds, p_ids) s(k, i), recipe.genealogy(s.k, s.i, 'FORWARD', p_as_of) g
   group by g.node_kind, g.node_id
$$;

-- ---------------------------------------------------------------------------------------------
-- The mock recall, version 1
-- ---------------------------------------------------------------------------------------------

create function recipe.mock_recall_result_v1(p_kind text, p_id uuid, p_as_of timestamptz) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with starts as (select coalesce(array_agg(s.kind order by s.kind, s.id), '{}') as ks, coalesce(array_agg(s.id order by s.kind, s.id), '{}') as ids
                    from recipe.mock_recall_starts(p_kind, p_id, p_as_of) s),
  n as materialized (select f.* from starts, recipe.genealogy_forward_set(starts.ks, starts.ids, p_as_of) f),
  batches as (
    select n.id, n.depth, recipe.genealogy_batch_number(n.id) as batch_number, recipe.batch_product(n.id) ->> 'code' as product_code
      from n where n.kind = 'BATCH'),
  ships as (
    select s.*, (s.unit = l.unit) as same_unit from n join site.erp_shipment s on n.kind = 'SHIPMENT' and s.id = n.id join site.material_lot l on l.id = s.lot_id),
  lots as (
    select l.id, l.lot_code, l.material_code, l.material_kind, l.unit, n.depth,
           coalesce((select sum(s.quantity) from ships s where s.lot_id = l.id and s.same_unit), 0) as delivered,
           coalesce((select sum(r.quantity) from site.returned_goods r where r.original_lot_id = l.id and r.received_at <= p_as_of), 0) as returned
      from n join site.material_lot l on n.kind = 'LOT' and l.id = n.id),
  cons as (
    select s.consignee_code,
           (array_agg(s.consignee_name order by s.recorded_at desc, s.id))[1] as consignee_name,
           (array_agg(s.consignee_address order by s.recorded_at desc, s.id) filter (where s.consignee_address is not null))[1] as consignee_address,
           array_agg(distinct s.market order by s.market) as markets,
           jsonb_agg(jsonb_build_object('shipment_no', s.shipment_no, 'lot_code', l.lot_code, 'quantity', s.quantity::text, 'unit', s.unit,
                                        'shipped_us', platform.timestamptz_to_epoch_us(coalesce(s.shipped_at, s.recorded_at)))
                     order by s.shipment_no) as shipments
      from ships s join site.material_lot l on l.id = s.lot_id
     group by s.consignee_code)
  select jsonb_build_object(
    'query_version', 1,
    'subject', jsonb_build_object('kind', p_kind, 'id', p_id),
    'as_of_us', platform.timestamptz_to_epoch_us(p_as_of),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'product_code', b.product_code, 'depth', b.depth)
                                          order by b.depth, b.batch_number, b.id) from batches b), '[]'),
    'lots', coalesce((select jsonb_agg(jsonb_build_object('lot_id', l.id, 'lot_code', l.lot_code, 'material_code', l.material_code, 'material_kind', l.material_kind,
                                                          'depth', l.depth, 'unit', l.unit, 'delivered', l.delivered::text, 'returned', l.returned::text,
                                                          'outstanding', (l.delivered - l.returned)::text)
                                       order by l.depth, l.lot_code, l.id) from lots l), '[]'),
    'consignees', coalesce((select jsonb_agg(jsonb_build_object('consignee_code', c.consignee_code, 'consignee_name', c.consignee_name,
                                                                'consignee_address', c.consignee_address, 'markets', to_jsonb(c.markets), 'shipments', c.shipments)
                                             order by c.consignee_code) from cons c), '[]'),
    'incomplete', coalesce((select jsonb_agg(s.shipment_no order by s.shipment_no) from ships s where s.consignee_address is null or not s.same_unit), '[]'),
    'counts', jsonb_build_object(
      'batches', (select count(*) from batches), 'lots', (select count(*) from lots), 'consignees', (select count(*) from cons),
      'shipments', (select count(*) from ships), 'incomplete_records', (select count(*) from ships s where s.consignee_address is null or not s.same_unit)))
$$;

create function recipe.mock_recall_sha256(p_result jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(p_result::text, 'UTF8')), 'hex')
$$;

create function recipe.mock_recall_run_query(p_version integer, p_kind text, p_id uuid, p_as_of timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if p_version = 1 then
    return recipe.mock_recall_result_v1(p_kind, p_id, p_as_of);
  end if;
  raise exception using errcode = 'P0001', message = format('EBMR-RCL-005 mock recall query version %s is not runnable here', coalesce(p_version::text, 'NULL'));
end
$$;

create function recipe.mock_recall_reproduces(p_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select recipe.mock_recall_sha256(recipe.mock_recall_run_query(m.query_version, m.subject_kind, m.subject_id, m.as_of)) = m.result_sha256
    from recipe.mock_recall m where m.id = p_id
$$;

create function recipe.run_mock_recall(p_kind text, p_id uuid, p_as_of timestamptz, p_informed boolean, p_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  v_actor  jsonb;
  v_as_of  timestamptz := coalesce(p_as_of, clock_timestamp());
  v_ref    text;
  v_result jsonb;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECALL.MOCK_RUN', '{}'::jsonb);
  if p_kind is null or p_kind not in ('LOT', 'DEVIATION') then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-001 a mock recall starts from a LOT or a DEVIATION, not %s', coalesce(p_kind, 'NULL'));
  end if;
  if v_as_of > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-002 the as-of point of a mock recall is now or in the past (D-P6d-0-3)';
  end if;
  if p_kind = 'LOT' then
    select l.lot_code into v_ref from site.material_lot l where l.id = p_id and l.received_at <= v_as_of;
  else
    select d.ref into v_ref from site.deviation d where d.id = p_id and d.raised_at <= v_as_of;
  end if;
  if v_ref is null then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-003 there is no %s %s as of the instant asked', lower(p_kind), coalesce(p_id::text, 'NULL'));
  end if;
  if p_kind = 'DEVIATION' and not exists (select 1 from recipe.mock_recall_starts(p_kind, p_id, v_as_of)) then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-004 deviation %s links no batch, lot or container as of the instant asked; link the affected subjects first (PR-50)', v_ref);
  end if;
  if p_informed is null or (p_informed and btrim(coalesce(p_reference, '')) = '') or (not p_informed and p_reference is not null) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-RCL-006 a mock recall states whether the licensing authority was informed of the intended recall, with the reference of that notice when it was (IN-29)';
  end if;
  v_result := recipe.mock_recall_run_query(1, p_kind, p_id, v_as_of);
  insert into recipe.mock_recall (subject_kind, subject_id, subject_ref, as_of, query_version, result, result_sha256, authority_informed, authority_reference,
                                  person_id, account_id, role_code, correlation_id)
  values (p_kind, p_id, v_ref, v_as_of, 1, v_result, recipe.mock_recall_sha256(v_result), p_informed, nullif(btrim(coalesce(p_reference, '')), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code', (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.mock_recall_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m recipe.mock_recall;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into m from recipe.mock_recall where id = p_id::uuid;
  if m.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'state', case when exists (select 1 from recipe.mock_recall_signoff s where s.mock_recall_id = m.id) then 'SIGNED_OFF' else 'RUN' end,
    'content', jsonb_build_object('mock_recall_id', m.id, 'subject_kind', m.subject_kind, 'subject_ref', m.subject_ref,
                                  'as_of_us', platform.timestamptz_to_epoch_us(m.as_of), 'query_version', m.query_version,
                                  'result_sha256', m.result_sha256, 'counts', m.result -> 'counts',
                                  'authority_informed', m.authority_informed, 'authority_reference', m.authority_reference),
    'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('mock_recall', 'recipe.mock_recall_content(text)',
  'A mock recall from a lot or a deviation as of an instant, signed off by the authorised person (IN-29, PR-57)');

create function recipe.sign_off_mock_recall(p_id uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, pg_temp as $$
declare
  v_actor   jsonb;
  m         recipe.mock_recall;
  v_sig     jsonb;
  v_role    text;
  v_content text;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  select * into m from recipe.mock_recall where id = p_id;
  if m.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-010 there is no mock recall %s', coalesce(p_id::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECALL.MOCK_SIGN_OFF', '{}'::jsonb);
  perform 1 from recipe.mock_recall where id = m.id for update;
  if exists (select 1 from recipe.mock_recall_signoff s where s.mock_recall_id = m.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-011 this mock recall is signed off already';
  end if;
  if not recipe.mock_recall_reproduces(m.id) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-RCL-012 a re-run as of the same instant no longer gives the stored result (a transaction straddled the as-of point); run the mock recall again and sign that one (D-P6d-0-3)';
  end if;
  v_sig := recipe.assert_release_signature(p_signature, 'MOCK_RECALL_SIGNED_OFF', 'mock_recall', m.id::text, (v_actor ->> 'person_id')::uuid);
  select s.signer_role_code into v_role from esig.signature s where s.id = p_signature;
  if v_role is distinct from 'AUTHORISED_PERSON' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-RCL-013 a mock recall is signed off by the authorised person, who owns recall execution, not as %s (IN-29)', coalesce(v_role, 'no role'));
  end if;
  v_content := esig.content_hash_of('mock_recall', m.id::text, esig.provide('mock_recall', m.id::text));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-014 the signed mock recall is not the current one; sign it again (DI-37)';
  end if;
  insert into recipe.mock_recall_signoff (mock_recall_id, result_sha256, signature_id, content_hash, person_id, account_id, role_code, correlation_id)
  values (m.id, m.result_sha256, p_signature, v_content, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_role,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The deviation impact query (PR-50)
-- ---------------------------------------------------------------------------------------------

create function recipe.deviation_impact_batches(p_deviation uuid, p_as_of timestamptz)
returns table (batch_id uuid, batch_number text, product_code text, relation text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_as_of  timestamptz := coalesce(p_as_of, clock_timestamp());
  v_linked uuid[];
  v_down   uuid[];
  v_shared uuid[];
  v_lots   uuid[];
  v_others uuid[];
begin
  if not exists (select 1 from site.deviation d where d.id = p_deviation and d.raised_at <= v_as_of) then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-015 there is no deviation %s as of the instant asked', coalesce(p_deviation::text, 'NULL'));
  end if;
  if v_as_of > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-002 the as-of point is now or in the past (D-P6d-0-3)';
  end if;
  -- LINKED: the batches the links name, and the batch of a linked finished lot.
  select coalesce(array_agg(distinct b), '{}') into v_linked from (
    select y.batch_id as b from site.deviation_link y where y.deviation_id = p_deviation and y.linked_at <= v_as_of and y.batch_id is not null
    union
    select f.batch_id from site.deviation_link y join site.finished_lot f on f.lot_id = y.subject_id
     where y.deviation_id = p_deviation and y.linked_at <= v_as_of and y.subject_kind = 'LOT' and f.posted_at <= v_as_of) x;
  -- DOWNSTREAM: every batch forward of a linked subject.
  select coalesce(array_agg(distinct g.id), '{}') into v_down
    from (select coalesce(array_agg(s.kind), '{}') ks, coalesce(array_agg(s.id), '{}') ids from recipe.mock_recall_starts('DEVIATION', p_deviation, v_as_of) s) st,
         recipe.genealogy_forward_set(st.ks, st.ids, v_as_of) g
   where g.kind = 'BATCH' and not (g.id = any (v_linked));
  -- SHARED_LOT: batches that consumed a lot a linked batch consumed, and everything forward of them.
  select coalesce(array_agg(distinct c.lot_id), '{}') into v_lots from site.lot_consumption c where c.batch_id = any (v_linked) and c.consumed_at <= v_as_of;
  select coalesce(array_agg(distinct c.batch_id), '{}') into v_others from site.lot_consumption c
   where c.lot_id = any (v_lots) and c.consumed_at <= v_as_of and not (c.batch_id = any (v_linked));
  select coalesce(array_agg(distinct g.id), '{}') into v_shared
    from recipe.genealogy_forward_set(array_fill('BATCH'::text, array[cardinality(v_others)]), v_others, v_as_of) g
   where g.kind = 'BATCH' and not (g.id = any (v_linked)) and not (g.id = any (v_down));
  return query
    select x.b, recipe.genealogy_batch_number(x.b), recipe.batch_product(x.b) ->> 'code', x.r
      from (select unnest(v_linked) b, 'LINKED'::text r, 1 o union all select unnest(v_down), 'DOWNSTREAM', 2 union all select unnest(v_shared), 'SHARED_LOT', 3) x
     order by x.o, recipe.genealogy_batch_number(x.b), x.b;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The recurrence count (PR-49)
-- ---------------------------------------------------------------------------------------------

-- The root-cause category of a deviation's latest finding, NULL before one.
create function recipe.deviation_latest_category(p_deviation uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select f.root_cause_category from site.deviation_finding f where f.deviation_id = p_deviation order by f.recorded_at desc, f.id desc limit 1
$$;

-- Whether a deviation is linked to the product (a batch of it, or a lot of it).
create function recipe.deviation_of_product(p_deviation uuid, p_product text) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select exists (select 1 from site.deviation_link y
                  where y.deviation_id = p_deviation
                    and ((y.batch_id is not null and recipe.batch_product(y.batch_id) ->> 'code' = p_product)
                         or (y.subject_kind = 'LOT' and exists (select 1 from site.material_lot l where l.id = y.subject_id and l.material_code = p_product))))
$$;

create function recipe.deviation_recurrence(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with lot as (select f.lot_id, f.product_code from site.finished_lot f where f.lot_id = p_lot),
  devs as (
    select d.id, d.ref, d.title, recipe.deviation_latest_category(d.id) as category, lot.product_code
      from lot, site.deviation d where d.id = any (recipe.release_deviations(lot.lot_id)) and site.deviation_state(d.id) <> 'CANCELLED'),
  items as (
    select v.*, coalesce(o.others, '[]'::jsonb) as others, coalesce(o.n, 0) as n
      from devs v left join lateral (
        select jsonb_agg(jsonb_build_object('deviation_id', d2.id, 'ref', d2.ref, 'raised_us', platform.timestamptz_to_epoch_us(d2.raised_at)) order by d2.raised_at, d2.id) as others,
               count(*)::integer as n
          from site.deviation d2
         where v.category is not null and v.category <> 'NOT_DETERMINED' and d2.id <> v.id
           and d2.raised_at > clock_timestamp() - interval '365 days' and site.deviation_state(d2.id) <> 'CANCELLED'
           and recipe.deviation_latest_category(d2.id) = v.category and recipe.deviation_of_product(d2.id, v.product_code)) o on true)
  select jsonb_build_object(
    'lot_id', p_lot, 'threshold', 3, 'window_days', 365,
    'warning', coalesce(bool_or(i.category is not null and i.category <> 'NOT_DETERMINED' and i.n + 1 >= 3), false),
    'items', coalesce(jsonb_agg(jsonb_build_object('deviation_id', i.id, 'ref', i.ref, 'title', i.title, 'root_cause_category', i.category,
                                                   'product_code', i.product_code,
                                                   'occurrences', case when i.category is null or i.category = 'NOT_DETERMINED' then 0 else i.n + 1 end,
                                                   'warning', i.category is not null and i.category <> 'NOT_DETERMINED' and i.n + 1 >= 3,
                                                   'others', i.others) order by i.ref), '[]'))
  from items i
$$;

revoke all on function recipe.genealogy_batch_number(uuid), recipe.mock_recall_starts(text, uuid, timestamptz),
  recipe.genealogy_forward_set(text[], uuid[], timestamptz), recipe.mock_recall_result_v1(text, uuid, timestamptz), recipe.mock_recall_sha256(jsonb),
  recipe.mock_recall_run_query(integer, text, uuid, timestamptz), recipe.mock_recall_reproduces(uuid), recipe.run_mock_recall(text, uuid, timestamptz, boolean, text),
  recipe.mock_recall_content(text), recipe.sign_off_mock_recall(uuid, uuid), recipe.deviation_impact_batches(uuid, timestamptz),
  recipe.deviation_latest_category(uuid), recipe.deviation_of_product(uuid, text), recipe.deviation_recurrence(uuid) from public;
grant execute on function recipe.genealogy_batch_number(uuid), recipe.mock_recall_sha256(jsonb), recipe.mock_recall_reproduces(uuid),
  recipe.run_mock_recall(text, uuid, timestamptz, boolean, text), recipe.sign_off_mock_recall(uuid, uuid), recipe.deviation_impact_batches(uuid, timestamptz),
  recipe.deviation_recurrence(uuid), recipe.genealogy_forward_set(text[], uuid[], timestamptz) to ebmr_app;

reset role;
