-- Recipe core: changing a batch's or a finished lot's market set after issue (Phase 4 slice 4a; outline 3.3.3, 5.2.7
-- item 8; INV-43, INV-28; ADR 0012). Interfaces of 4-0 (0820) filled from their definitions there: recipe.market_set
-- and recipe.market_add_evaluate.
--
--   recipe.market_change (insert-only, audited): one row per signed change of a subject's set: ADD (QA's MARKET_ADDED
--       signature, a change record, and the market-add evaluation evaluated in the act and stored with it) or REMOVE
--       (QA's MARKET_REMOVED signature and a deviation-lite record linked to the subject; the "removed after failure"
--       flag computed in the act). The original resolution stays in the record; a later change never relabels it.
--   recipe.market_set(kind, id): the original set plus the changes in their order. India is never added or removed
--       (INV-28: every batch is made under an Indian licence).
--   recipe.market_add_evaluate(kind, id, market): the evaluation against the recorded data, items:
--       MA.MBR_AUTHORISATION  each batch of the subject (a LOT: its packaging batch and the processing batch it packs; a
--                             packaging BATCH: itself and its parent) was issued on a master version holding a valid cell
--                             for the market at the issue instant (recipe.valid_cells): else UNMET_FINAL (the record was
--                             made to a master the market never authorised).
--       MA.IDENTITY_ROUTE     every lot those batches consumed has an identity basis valid for the widened set
--                             (site.identity_rule_problem), and an identity result it rests on was recorded before the
--                             lot's first use in the batch: else UNMET_FINAL (the test had to precede use; 3.3.3).
--       MA.RELEASE_TESTS      (LOT) the lot's required release tests are done and approved (site.lot_lims_release_problem):
--                             else UNMET_RECOVERABLE (an extra test is still possible).
--       MA.RESERVE_SAMPLES    (LOT) the reserve samples are taken (site.lot_sample_problem): else UNMET_RECOVERABLE.
--       The outcome is the worst item's. Not yet evaluated (residual, recorded in the plan): stricter keys per step
--       (verifier counts, IPC intervals, hold times), label rules, retention; injectables items (filters, PUPSIT, APS, EM).
--   recipe.record_market_change(kind, id, change, market, ref, signature) RECORD.QA_REVIEW, signed by the actor:
--       ADD     the market is not in the set; ref is a change record; a packaging batch's parent holds the market first
--               (packaging orders only for markets inside the parent's set, 3.3.3); the evaluation is stored. An
--               UNMET_FINAL item makes the market's disposition INELIGIBLE (terminal; 0822).
--       REMOVE  the market is in the set; ref is a deviation-lite record linked to the subject or a batch of its records
--               and not cancelled; a lot whose disposition for the market is RELEASED or CERTIFIED is not changed here
--               (slice 5's paths); a processing batch keeps a market while a packaging order of it holds it. Flag
--               "removed after failure": the disposition was REJECTED, REJECTED_BY_QP or INELIGIBLE, the market-add
--               evaluation is not MET, or a linked deviation's latest impact for the market is POTENTIAL or CONFIRMED.
--   Packaging orders (3.3.3): a trigger on recipe.batch_allocation_link refuses a packaging order planned for a market
--       its processing batch's set does not hold (EBMR-DSP-016: run the market add on the processing batch first).
--
-- Signed aggregate: market_change <LOT|BATCH>/<id>/<ADD|REMOVE>/<market>/<n>, n the subject's n-th change of that market
-- (4-0 named it without <n>; the sequence keeps each signature's content its own: a recorded change provides the content
-- stored with it). New meanings MARKET_ADDED, MARKET_REMOVED (QA; RECORD.QA_REVIEW).
-- Messages: EBMR-DSP-010 to EBMR-DSP-029.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0821_market_changes)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'market add and removal after issue (outline 3.3.3; INV-43)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('MARKET_ADDED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Market added after issue',
   'Quality unit: I add this market to the set under the cited change record, with the market-add evaluation shown.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 3.3.3; INV-43'),
  ('MARKET_REMOVED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Market removed after issue',
   'Quality unit: I remove this market from the set under the cited deviation; nothing already evaluated is relabelled.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 3.3.3');

select kernel.set_actor_context(null);

create table recipe.market_change (
  id                     uuid primary key default gen_random_uuid(),
  subject_kind           text not null check (subject_kind in ('BATCH', 'LOT')),
  subject_id             uuid not null,
  seq                    integer not null check (seq >= 1),
  change                 text not null check (change in ('ADD', 'REMOVE')),
  market                 text not null check (market in ('US', 'EU')),
  change_record_id       uuid references recipe.change_record (id),
  deviation_id           uuid,
  removed_after_failure  boolean not null default false,
  evaluation             jsonb,
  content                jsonb not null check (jsonb_typeof(content) = 'object'),
  signature_id           uuid not null unique,
  person_id              uuid not null,
  account_id             uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  unique (subject_kind, subject_id, market, seq),
  check ((change = 'ADD') = (change_record_id is not null and evaluation is not null)),
  check ((change = 'REMOVE') = (deviation_id is not null)),
  check (change = 'REMOVE' or not removed_after_failure)
);
revoke all on recipe.market_change from public;
grant select on recipe.market_change to ebmr_app;
select platform.enforce_db_time('recipe.market_change', array['recorded_at']);
select kernel.register_audited_table('recipe.market_change', 'market_change', 'id', true);

-- The base set of a subject: an issued batch's issued set, a finished lot's posted set.
create function recipe.market_base_set(p_kind text, p_id uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case p_kind
           when 'BATCH' then (select b.market_set from recipe.batch_execution b where b.id = p_id)
           when 'LOT' then (select f.markets from site.finished_lot f where f.lot_id = p_id)
         end
$$;

create or replace function recipe.market_set(p_kind text, p_id uuid) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_set text[] := recipe.market_base_set(p_kind, p_id);
  c     recipe.market_change;
begin
  if v_set is null then
    return null;
  end if;
  for c in select * from recipe.market_change x where x.subject_kind = p_kind and x.subject_id = p_id order by x.recorded_at, x.seq loop
    if c.change = 'ADD' then
      v_set := v_set || c.market;
    else
      v_set := array_remove(v_set, c.market);
    end if;
  end loop;
  return array(select distinct m from unnest(v_set) m order by m);
end
$$;

-- The batches a subject's evaluation covers: a lot's evidence set; a batch and, for a packaging order, its parent.
create function recipe.market_subject_batches(p_kind text, p_id uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case p_kind
           when 'LOT' then recipe.release_batches(p_id)
           when 'BATCH' then (select array_agg(x) from (select p_id as x union all select recipe.packaging_parent_of(p_id)) y where x is not null)
         end
$$;

create or replace function recipe.market_add_evaluate(p_kind text, p_id uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_set     uuid[];
  v_items   jsonb := '[]'::jsonb;
  b         uuid;
  s         recipe.stub_batch;
  x         recipe.batch_execution;
  v_ver     recipe.mbr_version;
  v_out     text;
  v_detail  text;
  v_ev      jsonb;
  v_markets text[];
  r         record;
  v_prob    text;
  v_basis   text;
begin
  if p_kind is null or p_kind not in ('BATCH', 'LOT') or p_market is null or p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-010 a market-add evaluation is for a BATCH or LOT and the market IN, US or EU, not %s %s',
                                                              coalesce(p_kind, 'NULL'), coalesce(p_market, 'NULL'));
  end if;
  v_set := coalesce(recipe.market_subject_batches(p_kind, p_id), '{}');
  if cardinality(v_set) = 0 or recipe.market_base_set(p_kind, p_id) is null then
    return jsonb_build_object('subject_kind', p_kind, 'subject_id', p_id, 'market', p_market, 'outcome', 'UNMET_FINAL',
             'items', jsonb_build_array(jsonb_build_object('id', 'MA.SUBJECT', 'title', 'Issued batch or finished lot', 'outcome', 'UNMET_FINAL',
                                                           'detail', format('%s %s is no issued GMP batch or finished lot', lower(p_kind), p_id), 'evidence', '[]'::jsonb)));
  end if;

  -- MA.MBR_AUTHORISATION: the master each batch was issued on was valid for the market at the issue instant.
  v_out := 'MET';
  v_detail := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    select * into s from recipe.stub_batch where id = b;
    select * into x from recipe.batch_execution where id = b;
    v_ver := recipe.batch_master_version(b);
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b, 'label', format('%s on master version %s', x.batch_number, v_ver.version_number)));
    if s.id is null or x.id is null or v_ver.id is null
       or not exists (select 1 from recipe.valid_cells(s.family_id, array[p_market], s.site, s.line, s.batch_size, x.issued_at) c where c.version_id = v_ver.id) then
      v_out := 'UNMET_FINAL';
      v_detail := coalesce(v_detail, format('batch %s was issued on master version %s, which held no valid authorisation for %s at %s (5.2 MBR; INV-01)',
                                            x.batch_number, v_ver.version_number, p_market, to_char(x.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(jsonb_build_object('id', 'MA.MBR_AUTHORISATION', 'title', 'Master version authorised for the market when the batch was issued',
                                                             'outcome', v_out, 'detail', v_detail, 'evidence', v_ev));

  -- MA.IDENTITY_ROUTE: every consumed lot's identity basis holds for the widened set and preceded its use.
  v_out := 'MET';
  v_detail := null;
  v_ev := '[]'::jsonb;
  for r in select c.lot_id, c.batch_id, min(c.consumed_at) as first_use from site.lot_consumption c where c.batch_id = any (v_set) group by c.lot_id, c.batch_id order by 1, 2 loop
    select array(select distinct m from unnest(coalesce(recipe.market_set('BATCH', r.batch_id), '{}') || p_market) m order by m) into v_markets;
    select p.p_problem, p.p_basis into v_prob, v_basis from site.identity_rule_problem((select l from site.material_lot l where l.id = r.lot_id), v_markets) p;
    if v_prob is null and v_basis = 'IDENTITY_RESULT'
       and not exists (select 1 from site.lot_identity_result i where i.lot_id = r.lot_id and i.result = 'PASS' and i.recorded_at <= r.first_use) then
      v_prob := format('the identity result of lot %s was recorded after the lot was first used in batch %s; the test had to precede use (3.3.3; IN-24)',
                       (select l.lot_code from site.material_lot l where l.id = r.lot_id), (select y.batch_number from recipe.batch_execution y where y.id = r.batch_id));
    end if;
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', r.lot_id,
              'label', format('%s (%s)', (select l.lot_code from site.material_lot l where l.id = r.lot_id), coalesce(v_basis, 'no valid basis'))));
    if v_prob is not null then
      v_out := 'UNMET_FINAL';
      v_detail := coalesce(v_detail, v_prob);
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(jsonb_build_object('id', 'MA.IDENTITY_ROUTE', 'title', 'Identity-test route of every consumed lot valid for the market',
                                                             'outcome', v_out, 'detail', v_detail, 'evidence', v_ev));

  if p_kind = 'LOT' then
    v_prob := site.lot_lims_release_problem(p_id);
    v_items := v_items || jsonb_build_array(jsonb_build_object('id', 'MA.RELEASE_TESTS', 'title', 'Release tests done and approved',
                                                               'outcome', case when v_prob is null then 'MET' else 'UNMET_RECOVERABLE' end, 'detail', v_prob,
                                                               'evidence', jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', p_id, 'label', 'release results'))));
    v_prob := site.lot_sample_problem(p_id);
    v_items := v_items || jsonb_build_array(jsonb_build_object('id', 'MA.RESERVE_SAMPLES', 'title', 'Reserve samples taken',
                                                               'outcome', case when v_prob is null then 'MET' else 'UNMET_RECOVERABLE' end, 'detail', v_prob,
                                                               'evidence', jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', p_id, 'label', 'reserve samples'))));
  end if;

  return jsonb_build_object('subject_kind', p_kind, 'subject_id', p_id, 'market', p_market,
    'outcome', case when exists (select 1 from jsonb_array_elements(v_items) i where i ->> 'outcome' = 'UNMET_FINAL') then 'UNMET_FINAL'
                    when exists (select 1 from jsonb_array_elements(v_items) i where i ->> 'outcome' = 'UNMET_RECOVERABLE') then 'UNMET_RECOVERABLE'
                    else 'MET' end,
    'items', v_items);
end
$$;

-- The packaging orders planned on a processing batch (their allocation names the batch's allocation as parent).
create function recipe.packaging_children_of(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(array_agg(l.batch_id order by l.batch_id), '{}')
    from recipe.batch_allocation_link pl
    join site.batch_number_allocation a on a.parent_allocation_id = pl.allocation_id
    join recipe.batch_allocation_link l on l.allocation_id = a.id
   where pl.batch_id = p_batch
$$;

-- The finished lots whose evidence set holds the batch.
create function recipe.lots_of_batch(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(array_agg(f.lot_id order by f.lot_id), '{}') from site.finished_lot f where p_batch = any (recipe.release_batches(f.lot_id))
$$;

create function recipe.market_change_ref(p_kind text, p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case p_kind when 'BATCH' then (select b.batch_number from recipe.batch_execution b where b.id = p_id)
                     else (select l.lot_code from site.material_lot l where l.id = p_id) end
$$;

-- The scope of a market change: the batch's scope, or the lot's release scope.
create function recipe.market_change_scope(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
begin
  if p_kind = 'BATCH' then
    if not exists (select 1 from recipe.batch_execution b where b.id = p_id) then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-011 %s is no issued batch', coalesce(p_id::text, 'NULL'));
    end if;
    return plant.batch_scope(p_id);
  elsif p_kind = 'LOT' then
    return recipe.release_scope(p_id);
  end if;
  raise exception using errcode = 'P0001', message = format('EBMR-DSP-010 a market change is made to a BATCH or a LOT, not %s', coalesce(p_kind, 'NULL'));
end
$$;

-- Whether removing the market from the subject now is a removal after a failure against that market's rules (3.3.3).
create function recipe.market_failed(p_kind text, p_id uuid, p_market text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_lots uuid[] := case p_kind when 'LOT' then array[p_id] else recipe.lots_of_batch(p_id) end;
  v_bat  uuid[] := coalesce(recipe.market_subject_batches(p_kind, p_id), '{}');
  l      uuid;
begin
  foreach l in array v_lots loop
    if recipe.disposition_state(l, p_market) in ('REJECTED', 'REJECTED_BY_QP', 'INELIGIBLE') then
      return true;
    end if;
  end loop;
  if exists (select 1 from recipe.market_change c where c.change = 'ADD' and c.market = p_market
                and ((c.subject_kind = 'LOT' and c.subject_id = any (v_lots)) or (c.subject_kind = 'BATCH' and c.subject_id = any (v_bat))))
     and (recipe.market_add_evaluate(p_kind, p_id, p_market) ->> 'outcome') <> 'MET' then
    return true;
  end if;
  return exists (select 1 from site.deviation_link k
                  where ((k.subject_kind = 'LOT' and k.subject_id = any (v_lots)) or (k.subject_kind = 'BATCH' and k.subject_id = any (v_bat)))
                    and (site.deviation_latest_impact(k.id, p_market)).impact in ('POTENTIAL', 'CONFIRMED'));
end
$$;

create function recipe.market_change_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m     text[] := regexp_match(coalesce(p_id, ''), '^(BATCH|LOT)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(ADD|REMOVE)/(US|EU)/([1-9][0-9]{0,5})$');
  c     recipe.market_change;
  v_set text[];
  v_n   integer;
  v_scope jsonb;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_set := recipe.market_set(m[1], m[2]::uuid);
  if v_set is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_scope := case m[1] when 'BATCH' then plant.batch_scope(m[2]::uuid) else recipe.release_scope(m[2]::uuid) end;
  select * into c from recipe.market_change x where x.subject_kind = m[1] and x.subject_id = m[2]::uuid and x.market = m[4] and x.seq = m[5]::integer;
  if c.id is not null then
    if c.change <> m[3] then
      return '{"exists": false}'::jsonb;
    end if;
    -- A recorded change provides the content it was signed and stored with.
    return jsonb_build_object('exists', true, 'content_version', 1, 'content', c.content, 'market', c.market, 'state', 'RECORDED',
                              'scope', v_scope, 'involved', '[]'::jsonb);
  end if;
  select count(*) + 1 into v_n from recipe.market_change x where x.subject_kind = m[1] and x.subject_id = m[2]::uuid and x.market = m[4];
  if v_n <> m[5]::integer then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('subject_kind', m[1], 'subject_id', m[2], 'subject_ref', recipe.market_change_ref(m[1], m[2]::uuid), 'change', m[3],
                                  'market', m[4], 'sequence', v_n, 'market_set', to_jsonb(v_set),
                                  'evaluation', case m[3] when 'ADD' then recipe.market_add_evaluate(m[1], m[2]::uuid, m[4]) end,
                                  'removed_after_failure', case m[3] when 'REMOVE' then recipe.market_failed(m[1], m[2]::uuid, m[4]) end),
    'market', m[4],
    'state', case when m[4] = any (v_set) then 'IN_SET' else 'NOT_IN_SET' end,
    'scope', v_scope,
    'involved', '[]'::jsonb);
end
$$;

select esig.register_content_provider('market_change', 'recipe.market_change_content(text)',
  'A market added to or removed from an issued batch''s or a finished lot''s set, with its evaluation (outline 3.3.3)');

-- The aggregate id the next change of the subject's market signs.
create function recipe.market_change_next_id(p_kind text, p_id uuid, p_change text, p_market text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select format('%s/%s/%s/%s/%s', p_kind, p_id, p_change, p_market,
                (select count(*) + 1 from recipe.market_change x where x.subject_kind = p_kind and x.subject_id = p_id and x.market = p_market))
$$;

create function recipe.record_market_change(p_kind text, p_id uuid, p_change text, p_market text, p_ref uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, plant, pg_temp as $$
declare
  v_actor   jsonb;
  v_set     text[];
  v_aid     text;
  v_content jsonb;
  v_sig     jsonb;
  v_eval    jsonb;
  v_failed  boolean := false;
  v_parent  uuid;
  v_kids    uuid[];
  x         uuid;
  v_id      uuid;
  v_n       integer;
begin
  perform iam.assert_not_administrator();
  if p_change is null or p_change not in ('ADD', 'REMOVE') then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-012 %s is no market change (ADD or REMOVE)', coalesce(p_change, 'NULL'));
  end if;
  if p_market is null or p_market not in ('US', 'EU') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DSP-013 %s cannot be added or removed: India applies to every batch (INV-28); US and EU are added or removed after issue (3.3.3)', coalesce(p_market, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECORD.QA_REVIEW', recipe.market_change_scope(p_kind, p_id));

  -- Serialise with every act on the subject (release acts lock the lot; batch acts the execution state) and its epoch.
  if p_kind = 'LOT' then
    perform site.lock_lot(p_id);
    perform recipe.lock_epoch('LOT', p_id);
  else
    perform 1 from recipe.execution_state s where s.batch_id = p_id for update;
    perform recipe.lock_epoch('BATCH', p_id);
  end if;
  v_set := recipe.market_set(p_kind, p_id);
  if v_set is null then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-011 %s %s is no issued GMP batch or finished lot', lower(p_kind), p_id);
  end if;
  v_aid := recipe.market_change_next_id(p_kind, p_id, p_change, p_market);

  if p_change = 'ADD' then
    if p_market = any (v_set) then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-014 %s is already in the set of %s %s', p_market, lower(p_kind), recipe.market_change_ref(p_kind, p_id));
    end if;
    if p_ref is null or not exists (select 1 from recipe.change_record c where c.id = p_ref) then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-015 a market is added after issue under a change record (3.3.3)';
    end if;
    if p_kind = 'BATCH' then
      v_parent := recipe.packaging_parent_of(p_id);
      if v_parent is not null and not (p_market = any (coalesce(recipe.market_set('BATCH', v_parent), '{}'))) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-DSP-016 the processing batch %s this packaging order packs does not hold %s: add the market to it first (3.3.3)',
                           (select b.batch_number from recipe.batch_execution b where b.id = v_parent), p_market);
      end if;
    end if;
    v_eval := recipe.market_add_evaluate(p_kind, p_id, p_market);
  else
    if not (p_market = any (v_set)) then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-017 %s is not in the set of %s %s', p_market, lower(p_kind), recipe.market_change_ref(p_kind, p_id));
    end if;
    if p_ref is null or site.deviation_state(p_ref) is null then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-018 a market is removed after issue with a linked deviation record (3.3.3)';
    end if;
    if site.deviation_state(p_ref) = 'CANCELLED' then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-018 the deviation record named for the removal is CANCELLED';
    end if;
    if not exists (select 1 from site.deviation_link k where k.deviation_id = p_ref
                      and ((k.subject_kind = p_kind and k.subject_id = p_id)
                           or (k.subject_kind = 'BATCH' and k.subject_id = any (coalesce(recipe.market_subject_batches(p_kind, p_id), '{}'))))) then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-018 the deviation record is not linked to %s %s or a batch of its records (3.3.3)', lower(p_kind), recipe.market_change_ref(p_kind, p_id));
    end if;
    foreach x in array case p_kind when 'LOT' then array[p_id] else recipe.lots_of_batch(p_id) end loop
      if recipe.disposition_state(x, p_market) in ('RELEASED', 'CERTIFIED', 'RELEASE_SUSPENDED') then
        raise exception using errcode = 'P0001',
          message = format('EBMR-DSP-019 lot %s is %s for %s: a decided market is not removed; it follows the after-release paths (slice 5)',
                           (select l.lot_code from site.material_lot l where l.id = x), recipe.disposition_state(x, p_market), p_market);
      end if;
    end loop;
    if p_kind = 'BATCH' then
      v_kids := recipe.packaging_children_of(p_id);
      foreach x in array v_kids loop
        if p_market = any (coalesce(recipe.market_set('BATCH', x), (select s.markets from recipe.stub_batch s where s.id = x), '{}')) then
          raise exception using errcode = 'P0001',
            message = format('EBMR-DSP-020 packaging order %s of the batch holds %s: remove it there first (3.3.3)',
                             (select s.batch_number from recipe.stub_batch s where s.id = x), p_market);
        end if;
      end loop;
    end if;
    v_failed := recipe.market_failed(p_kind, p_id, p_market);
  end if;

  -- The signature: this change, this meaning, valid, the actor's own, on the content as it stands now.
  v_sig := recipe.assert_release_signature(p_signature, case p_change when 'ADD' then 'MARKET_ADDED' else 'MARKET_REMOVED' end, 'market_change', v_aid,
                                           (v_actor ->> 'person_id')::uuid);
  v_content := esig.provide('market_change', v_aid);
  if esig.content_hash_of('market_change', v_aid, v_content) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-021 the signed market change is not the current one (its evaluation moved); sign it again (DI-37)';
  end if;
  v_n := split_part(v_aid, '/', 5)::integer;
  insert into recipe.market_change (subject_kind, subject_id, seq, change, market, change_record_id, deviation_id, removed_after_failure, evaluation, content,
                                    signature_id, person_id, account_id)
  values (p_kind, p_id, v_n, p_change, p_market, case p_change when 'ADD' then p_ref end, case p_change when 'REMOVE' then p_ref end, v_failed,
          v_eval, v_content -> 'content', p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  -- The set changes what G-REL reads (items 8 and 11): the subject's epoch moves in this transaction.
  perform recipe.bump_epoch(p_kind, p_id);
  return v_id;
end
$$;

-- 3.3.3: a packaging order is planned only for markets inside its processing batch's set (the market add runs first).
create function recipe.packaging_order_markets_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_parent uuid := recipe.packaging_parent_of(new.batch_id);
  v_mk     text[];
  v_out    text[];
begin
  if v_parent is null then
    return null;
  end if;
  select s.markets into v_mk from recipe.stub_batch s where s.id = new.batch_id;
  v_out := array(select m from unnest(coalesce(v_mk, '{}')) m where not (m = any (coalesce(recipe.market_set('BATCH', v_parent), '{}'))) order by m);
  if cardinality(v_out) > 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DSP-016 the packaging order is planned for %s, outside the set of the processing batch it packs (%s): add the market to that batch first (3.3.3)',
                       array_to_string(v_out, ', '), array_to_string(coalesce(recipe.market_set('BATCH', v_parent), '{}'), ', '));
  end if;
  return null;
end
$$;
create trigger zzzm_packaging_order_markets after insert on recipe.batch_allocation_link for each row execute function recipe.packaging_order_markets_check();

revoke all on function recipe.market_base_set(text, uuid), recipe.market_subject_batches(text, uuid), recipe.packaging_children_of(uuid), recipe.lots_of_batch(uuid),
  recipe.market_change_ref(text, uuid), recipe.market_change_scope(text, uuid), recipe.market_failed(text, uuid, text), recipe.market_change_content(text),
  recipe.market_change_next_id(text, uuid, text, text), recipe.record_market_change(text, uuid, text, text, uuid, uuid), recipe.packaging_order_markets_check() from public;
grant execute on function recipe.market_change_next_id(text, uuid, text, text), recipe.record_market_change(text, uuid, text, text, uuid, uuid),
  recipe.market_failed(text, uuid, text) to ebmr_app;

reset role;
