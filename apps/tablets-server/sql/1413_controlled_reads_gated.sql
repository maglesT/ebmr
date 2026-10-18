-- Phase 7 slice 7a, 6jc-R2 (draft control IN-53, status U): the controlled-substance reads of the Tablets edition, for
-- the session behind the request, need CONTROLLED.READ in the record's scope (owner decision 0022; kernel 1300 catalogues
-- the permission, tablets 1400 grants it to every role holding a CONTROLLED.* permission and to QA_REVIEWER).
--
-- Handbook: modules/tablets-server.md
--
-- recipe-core 1214 takes the application role's direct reads away; these definers are now the only way ebmr_app reads
-- the controlled list, the custody records, the batch account and the register exports. The session is resolved from the
-- hash of its cookie token (tab.reader_of, 0410: an active session in a role granted now, EBMR-TAB-018); no command is
-- opened (as the formulation library's reads, 1041), so nothing is written by a read.
--
--   tab.controlled_reader_problem(reader, site, product, any_product)   NULL when the session's role holds CONTROLLED.READ
--       now, is no administration role and no break-glass account, and the account holds that role through a grant
--       whose scope covers {site, product} (iam.scope_covers, as iam.evaluate_authority scopes a grant); with
--       any_product the product is not asked (a list, filtered row by row after). Else why not:
--       EBMR-CSM-060 (no CONTROLLED.READ, or an administrator) or EBMR-CSM-061 (not in this scope).
--   tab.controlled_products(token, product)            the flag records, only of the products in the reader's scope
--   tab.controlled_custody(token, lot, batch, custody) custody records, only those in scope; a named batch or record
--                                                      out of scope is refused
--   tab.controlled_checkpoints(token, batch, checkpoint)  the yield-checkpoint accounts; the same rule
--   tab.controlled_balance(token, batch)               a batch's controlled account; NULL for an unknown batch (after
--                                                      the permission check), refused out of scope
--   tab.controlled_register_extracts(token, extract)   the register exports (the register spans every product of the
--                                                      material: read in the session's site with no product limit)
-- The scope of a record: a flag {session site, product}; a custody record {lot's site, batch's product when it names
-- a batch}; a checkpoint and a balance {batch's site, batch's product}; a register export {session site}. A grant
-- limited to a product never covers a record without one (iam.scope_covers). EBMR-CSM-060 and 061 answer 403.

set local role ebmr_owner;

create function tab.controlled_reader_problem(r tab.reader, p_site text, p_product text, p_any_product boolean default false) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_scope jsonb := jsonb_strip_nulls(jsonb_build_object('site', p_site, 'product', p_product));
begin
  if r.role_code is null or r.account_id is null or not tab.role_may(r.role_code, array['CONTROLLED.READ']) then
    return format('EBMR-CSM-060 %s acting as %s lacks CONTROLLED.READ: controlled-substance records are read only by the controlled-substance roles and QA (IN-53)',
                  coalesce(r.account_id::text, '(no account)'), coalesce(r.role_code, '(no role)'));
  end if;
  if iam.role_has_domain(r.role_code, 'ADMINISTRATION', clock_timestamp())
     or coalesce((select a.is_break_glass from iam.account a where a.id = r.account_id), true) then
    return format('EBMR-CSM-060 %s acting as %s: an administrator or break-glass account never reads controlled-substance records (IN-53, DI-18)',
                  r.account_id, r.role_code);
  end if;
  if not exists (select 1 from iam.role_grant g
                  where g.account_id = r.account_id and g.role_code = r.role_code
                    and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
                    and iam.scope_covers(g.scope_site, g.scope_area, case when p_any_product then null else g.scope_product end, v_scope)) then
    return format('EBMR-CSM-061 %s acting as %s holds CONTROLLED.READ in no grant covering scope %s (IN-53)', r.account_id, r.role_code,
                  case when p_any_product then v_scope - 'product' else v_scope end);
  end if;
  return null;
end
$$;

-- Raises the problem, if any (P0001; the server answers 403).
create function tab.controlled_reader_refusal(r tab.reader, p_site text, p_product text, p_any_product boolean default false) returns void
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text := tab.controlled_reader_problem(r, p_site, p_product, p_any_product);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
end
$$;

-- The site of the session a read is made for.
create function tab.reader_site(r tab.reader) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select s.site_code from iam.session s where s.id = r.session_id
$$;

-- A batch's {site, product} (recipe.batch_product, recipe-core 0504); NULL for an unknown batch.
create function tab.controlled_batch_scope(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('site', b.site_code, 'product', recipe.batch_product(b.id) ->> 'code') from recipe.batch_execution b where b.id = p_batch
$$;

create function tab.controlled_products(p_token_hash text, p_product text default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, pg_temp as $$
declare
  v_r    tab.reader := tab.reader_of(p_token_hash);
  v_site text := tab.reader_site(v_r);
begin
  perform tab.controlled_reader_refusal(v_r, v_site, null, true);
  return coalesce((
    select jsonb_agg(x.j order by x.product_code, x.recorded_at desc, x.id desc) from (
      select r.product_code, r.recorded_at, r.id,
             jsonb_build_object('id', r.id, 'product_code', r.product_code, 'controlled', r.controlled, 'material_codes', to_jsonb(r.material_codes),
                                'basis_ref', r.basis_ref, 'recorded_by_person', r.recorded_by_person,
                                'recorded_us', (extract(epoch from r.recorded_at) * 1000000)::numeric(20, 0)::text,
                                'state', plant.controlled_record_state(r.id), 'approved_by_person', a.approved_by_person,
                                'approved_us', case when a.record_id is null then null else (extract(epoch from a.approved_at) * 1000000)::numeric(20, 0)::text end,
                                'in_effect', to_jsonb(plant.controlled_materials(r.product_code))) as j
        from plant.controlled_product r left join plant.controlled_product_approval a on a.record_id = r.id
       where (p_product is null or r.product_code = p_product)
         and tab.controlled_reader_problem(v_r, v_site, r.product_code) is null
       order by r.product_code, r.recorded_at desc, r.id desc
       limit 2000) x), '[]'::jsonb);
end
$$;

create function tab.controlled_custody(p_token_hash text, p_lot uuid default null, p_batch uuid default null, p_custody uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
declare
  v_r     tab.reader := tab.reader_of(p_token_hash);
  v_scope jsonb;
begin
  perform tab.controlled_reader_refusal(v_r, tab.reader_site(v_r), null, true);
  if p_batch is not null then
    v_scope := tab.controlled_batch_scope(p_batch);
    if v_scope is not null then
      perform tab.controlled_reader_refusal(v_r, v_scope ->> 'site', v_scope ->> 'product');
    end if;
  end if;
  if p_custody is not null then
    select jsonb_build_object('site', l.site_code, 'product', case when c.batch_id is null then null else recipe.batch_product(c.batch_id) ->> 'code' end)
      into v_scope from recipe.controlled_custody c join site.material_lot l on l.id = c.lot_id where c.id = p_custody;
    if v_scope is not null then
      perform tab.controlled_reader_refusal(v_r, v_scope ->> 'site', v_scope ->> 'product');
    end if;
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.recorded_at desc, x.id) from (
      select c.recorded_at, c.id,
             jsonb_build_object('id', c.id, 'kind', c.kind, 'lot_id', c.lot_id, 'lot_code', l.lot_code, 'material_code', c.material_code,
                                'quantity', c.quantity::text, 'unit', c.unit, 'batch_id', c.batch_id, 'batch_number', b.batch_number,
                                'from_location', c.from_location, 'to_location', c.to_location, 'note', c.note,
                                'proposed_by_person', c.proposed_by_person,
                                'proposed_us', (extract(epoch from c.recorded_at) * 1000000)::numeric(20, 0)::text,
                                'state', recipe.controlled_custody_state(c.id),
                                'signatures', coalesce((select jsonb_agg(jsonb_build_object('position', s.position, 'person', s.person_id,
                                                                                            'us', (extract(epoch from s.recorded_at) * 1000000)::numeric(20, 0)::text)
                                                                         order by s.position)
                                                          from recipe.controlled_custody_signature s where s.custody_id = c.id), '[]'::jsonb),
                                'used', exists (select 1 from recipe.controlled_custody_use u where u.custody_id = c.id)) as j
        from recipe.controlled_custody c join site.material_lot l on l.id = c.lot_id left join recipe.batch_execution b on b.id = c.batch_id
       where (p_lot is null or c.lot_id = p_lot) and (p_batch is null or c.batch_id = p_batch) and (p_custody is null or c.id = p_custody)
         and tab.controlled_reader_problem(v_r, l.site_code, case when c.batch_id is null then null else recipe.batch_product(c.batch_id) ->> 'code' end) is null
       order by c.recorded_at desc, c.id
       limit 500) x), '[]'::jsonb);
end
$$;

-- The checkpoint rows of a batch or one checkpoint, without a permission check (owner only; the two readers below).
create function tab.controlled_checkpoint_rows(p_batch uuid, p_checkpoint uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(x.j order by x.recorded_at desc, x.id), '[]'::jsonb) from (
    select k.recorded_at, k.id,
           jsonb_build_object('id', k.id, 'stage_key', k.stage_key, 'material_code', k.material_code, 'unit', k.unit,
                              'dispensed', k.dispensed::text, 'consumed', k.consumed::text, 'in_process', k.in_process::text,
                              'returned', k.returned::text, 'destroyed', k.destroyed::text, 'difference', k.difference::text,
                              'explanation', k.explanation, 'deviation_id', k.deviation_id,
                              'deviation_ref', (select d.ref from site.deviation d where d.id = k.deviation_id),
                              'recorded_by_person', k.recorded_by_person,
                              'recorded_us', (extract(epoch from k.recorded_at) * 1000000)::numeric(20, 0)::text,
                              'state', recipe.controlled_checkpoint_state(k.id), 'current', recipe.controlled_checkpoint_current(k.id)) as j
      from recipe.controlled_checkpoint k
     where (p_batch is null or k.batch_id = p_batch) and (p_checkpoint is null or k.id = p_checkpoint)
     order by k.recorded_at desc, k.id
     limit 500) x
$$;

create function tab.controlled_checkpoints(p_token_hash text, p_batch uuid default null, p_checkpoint uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_r     tab.reader := tab.reader_of(p_token_hash);
  v_batch uuid := p_batch;
  v_scope jsonb;
begin
  perform tab.controlled_reader_refusal(v_r, tab.reader_site(v_r), null, true);
  if v_batch is null and p_checkpoint is not null then
    select k.batch_id into v_batch from recipe.controlled_checkpoint k where k.id = p_checkpoint;
  end if;
  if v_batch is null then
    -- Every checkpoint is of a batch: without one named or found there is nothing in any scope to show.
    return '[]'::jsonb;
  end if;
  v_scope := tab.controlled_batch_scope(v_batch);
  if v_scope is null then
    return '[]'::jsonb;
  end if;
  perform tab.controlled_reader_refusal(v_r, v_scope ->> 'site', v_scope ->> 'product');
  return tab.controlled_checkpoint_rows(v_batch, p_checkpoint);
end
$$;

create function tab.controlled_balance(p_token_hash text, p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_r     tab.reader := tab.reader_of(p_token_hash);
  v_scope jsonb;
begin
  perform tab.controlled_reader_refusal(v_r, tab.reader_site(v_r), null, true);
  v_scope := tab.controlled_batch_scope(p_batch);
  if v_scope is null then
    return null;
  end if;
  perform tab.controlled_reader_refusal(v_r, v_scope ->> 'site', v_scope ->> 'product');
  return (
    select jsonb_build_object('batch_number', b.batch_number, 'product', v_scope ->> 'product',
             'materials', coalesce((select jsonb_agg(jsonb_build_object('material_code', m.m, 'balance', recipe.controlled_balance(b.id, m.m)) order by m.m)
                                      from (select distinct x.m from (select unnest(recipe.batch_controlled_materials(b.id)) as m
                                                                       union select k.material_code from recipe.controlled_checkpoint k where k.batch_id = b.id) x) m), '[]'::jsonb),
             'checkpoints', tab.controlled_checkpoint_rows(b.id, null))
      from recipe.batch_execution b where b.id = p_batch);
end
$$;

create function tab.controlled_register_extracts(p_token_hash text, p_extract uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_r tab.reader := tab.reader_of(p_token_hash);
begin
  perform tab.controlled_reader_refusal(v_r, tab.reader_site(v_r), null);
  return coalesce((
    select jsonb_agg(x.j order by x.recorded_at desc, x.id) from (
      select e.recorded_at, e.id,
             jsonb_build_object('id', e.id, 'material_code', e.material_code, 'period_from', e.period_from::text, 'period_to', e.period_to::text,
                                'result_sha256', e.result_sha256, 'run_by_person', e.run_by_person, 'role_code', e.role_code,
                                'run_us', (extract(epoch from e.recorded_at) * 1000000)::numeric(20, 0)::text,
                                'rows', jsonb_array_length(e.result -> 'rows'))
             || case when p_extract is null then '{}'::jsonb
                     else jsonb_build_object('result', e.result, 'reproduces', recipe.controlled_register_reproduces(e.id)) end as j
        from recipe.controlled_register_extract e
       where p_extract is null or e.id = p_extract
       order by e.recorded_at desc, e.id
       limit 200) x), '[]'::jsonb);
end
$$;

revoke all on function tab.controlled_reader_problem(tab.reader, text, text, boolean), tab.controlled_reader_refusal(tab.reader, text, text, boolean),
  tab.reader_site(tab.reader), tab.controlled_batch_scope(uuid), tab.controlled_products(text, text),
  tab.controlled_custody(text, uuid, uuid, uuid), tab.controlled_checkpoint_rows(uuid, uuid), tab.controlled_checkpoints(text, uuid, uuid),
  tab.controlled_balance(text, uuid), tab.controlled_register_extracts(text, uuid) from public;
grant execute on function tab.controlled_products(text, text), tab.controlled_custody(text, uuid, uuid, uuid),
  tab.controlled_checkpoints(text, uuid, uuid), tab.controlled_balance(text, uuid), tab.controlled_register_extracts(text, uuid) to ebmr_app;

reset role;
