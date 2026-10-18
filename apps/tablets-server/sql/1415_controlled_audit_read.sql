-- Phase 7 slice 7a, 6jc-R2 review round 1 (draft control IN-53, status U): the audit viewer shows controlled-substance
-- entries only to a reader holding CONTROLLED.READ in the record's scope; and the register exports are read only with a
-- grant that has no site or product limit.
--
-- Handbook: modules/tablets-server.md
--
-- What was wrong. Tablets 1413 and 1414 gated the controlled reads, the signing preview and the signatures, but the audit
-- viewer (tablets 0420, re-created by 0440, 0530 and 0560) decided the chains of the controlled records by role alone:
-- controlled_product, controlled_custody, controlled_checkpoint and controlled_register_extract chains are GOVERNANCE
-- class, read by every governance reader; and recipe-core 1032 and 1033 file the custody rows on the lot's chain
-- (material_lot:<lot>) and the checkpoint rows on the batch's chain (batch:<id>), RECORD class, read by every holder of
-- RECORD.READ. Each entry names the table, the record, who acted and when. And tab.controlled_register_extracts read an
-- export in the session's site, though an export carries no site and covers the material's lots at every site
-- (recipe.controlled_register_v1 has no site filter; recipe.run_controlled_register runs it in the scope {}).
--
-- Now:
--   tab.controlled_aggregate_problem(reader, type, id)  NULL for a type that is not controlled; for a flag, a custody
--       record or a checkpoint, tab.controlled_reader_problem (1413) in the record's scope (tab.controlled_record_scope,
--       1414; an unknown record: the session's site, any product); for a register export, in the scope {} (a grant with
--       no site and no product limit). The problem is given without its code (the callers add EBMR-TAB-020).
--   tab.controlled_entry_hidden(reader, table, record)  whether an audit entry of one of the eight controlled tables
--       (recipe-core 1031 to 1034) is left out for the reader: its record id is the controlled record's (the kernel takes
--       a row's id, else its aggregate column), judged as above.
--   tab.chain_read_problem: CREATE OR REPLACE from its latest definition (0530): first, for the four controlled chain
--       prefixes, tab.controlled_aggregate_problem; then every rule of 0530 unchanged and in the same order.
--   tab.audit_events: CREATE OR REPLACE from 0530: the same checks in the same order; the entries of the controlled
--       tables are left out for a reader who may not read them (on every chain, the lot's and the batch's included), and
--       a list across chains lists no controlled chain the reader may not read.
--   tab.audit_chains, tab.audit_headless_chains: CREATE OR REPLACE from 0560: the same, and no controlled chain the reader
--       may not read is listed.
--   tab.controlled_register_extracts: CREATE OR REPLACE from 1413: the reader must hold CONTROLLED.READ in the scope {}.
-- Known limit (as default F35.3 for withheld entries): on a lot's or a batch's chain the length, the last sequence number
-- and the verification count every entry, controlled ones included; they show that entries exist, never what they say.
-- Every function keeps its signature, owner, SECURITY DEFINER, search_path and grants; the two new ones are private.

set local role ebmr_owner;

create function tab.controlled_aggregate_problem(r tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_scope jsonb;
begin
  if p_aggregate_type = 'controlled_register_extract' then
    return regexp_replace(tab.controlled_reader_problem(r, null, null), '^EBMR-[A-Z]+-[0-9]{3} ', '');
  end if;
  if p_aggregate_type in ('controlled_product', 'controlled_custody', 'controlled_checkpoint') then
    v_scope := tab.controlled_record_scope(p_aggregate_type, p_aggregate_id);
    return regexp_replace(tab.controlled_reader_problem(r, coalesce(v_scope ->> 'site', tab.reader_site(r)), v_scope ->> 'product', v_scope is null),
                          '^EBMR-[A-Z]+-[0-9]{3} ', '');
  end if;
  return null;
end
$$;

create function tab.controlled_entry_hidden(r tab.reader, p_table text, p_record_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select case p_table
           when 'plant.controlled_product' then 'controlled_product'
           when 'plant.controlled_product_approval' then 'controlled_product'
           when 'recipe.controlled_custody' then 'controlled_custody'
           when 'recipe.controlled_custody_signature' then 'controlled_custody'
           when 'recipe.controlled_custody_use' then 'controlled_custody'
           when 'recipe.controlled_checkpoint' then 'controlled_checkpoint'
           when 'recipe.controlled_checkpoint_signature' then 'controlled_checkpoint'
           when 'recipe.controlled_register_extract' then 'controlled_register_extract'
         end is not null
     and tab.controlled_aggregate_problem(r, case p_table
           when 'plant.controlled_product' then 'controlled_product'
           when 'plant.controlled_product_approval' then 'controlled_product'
           when 'recipe.controlled_custody' then 'controlled_custody'
           when 'recipe.controlled_custody_signature' then 'controlled_custody'
           when 'recipe.controlled_custody_use' then 'controlled_custody'
           when 'recipe.controlled_checkpoint' then 'controlled_checkpoint'
           when 'recipe.controlled_checkpoint_signature' then 'controlled_checkpoint'
           else 'controlled_register_extract' end, p_record_id) is not null
$$;

create or replace function tab.chain_read_problem(p_reader tab.reader, p_chain_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_prefix  text := split_part(p_chain_key, ':', 1);
  v_rest    text := substr(p_chain_key, length(v_prefix) + 2);
  v_problem text;
begin
  -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): a controlled record's chain needs CONTROLLED.READ in its scope.
  if v_prefix in ('controlled_product', 'controlled_custody', 'controlled_checkpoint', 'controlled_register_extract') then
    v_problem := tab.controlled_aggregate_problem(p_reader, v_prefix, v_rest);
    if v_problem is not null then
      return v_problem;
    end if;
  end if;
  if v_prefix in ('esig_signature', 'esig_challenge') then
    return tab.record_read_problem(p_reader, split_part(v_rest, ':', 1), substr(v_rest, length(split_part(v_rest, ':', 1)) + 2));
  end if;
  if v_prefix = 'di_investigation' then
    return tab.record_read_problem(p_reader, 'di_investigation', v_rest);
  end if;
  if tab.audit_chain_class(p_chain_key) = 'RECORD' then
    if tab.role_may(p_reader.role_code, array['RECORD.READ']) then
      return null;
    end if;
    return format('the role %s does not hold RECORD.READ', p_reader.role_code);
  end if;
  if tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
    return null;
  end if;
  return format('%s chains are read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these',
                v_prefix, array_to_string(tab.governance_read_permissions(), ', '), p_reader.role_code);
end
$$;

create or replace function tab.audit_events(p_token_hash text, p_chain_key text, p_correlation_id uuid, p_person_id uuid, p_from_us text, p_to_us text,
                                            p_after_id text, p_up_to_id text, p_limit integer)
returns table (id text, chain_key text, seq text, us text, correlation_id text, action text, table_name text, record_id text, payload jsonb,
               login_name text, device_code text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
  v_problem  text;
begin
  if p_chain_key is not null then
    v_problem := tab.chain_read_problem(v_reader, p_chain_key);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
    end if;
    if p_chain_key = any (v_withheld.chains) then
      return;
    end if;
  end if;
  if p_person_id is not null and p_person_id <> v_reader.person_id and not v_gov then
    raise exception using errcode = 'P0001', message = format(
      'Another person''s activity across the audit trail is read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these. [EBMR-TAB-020]',
      array_to_string(tab.governance_read_permissions(), ', '), v_reader.role_code);
  end if;
  return query
    select e.id::text, coalesce(e.payload ->> 'chain_key', ''), coalesce(e.payload ->> 'seq', ''), tab.audit_entry_us(e),
           e.payload ->> 'correlation_id', coalesce(e.payload ->> 'action', ''), e.payload ->> 'table', e.payload ->> 'record_id', e.payload,
           tab.audit_registry_value('account', 'iam.account', e.payload -> 'actor' ->> 'account_id', 'login_name'),
           tab.audit_registry_value('device', 'iam.device', e.payload -> 'actor' ->> 'device_id', 'code')
      from kernel.audit_event e
     where (p_chain_key is null or e.chain_key = p_chain_key)
       and (p_correlation_id is null or e.correlation_id = p_correlation_id)
       and (p_person_id is null or e.payload -> 'actor' ->> 'person_id' = p_person_id::text)
       and (p_from_us is null or e.recorded_at >= timestamptz 'epoch' + p_from_us::bigint * interval '1 microsecond')
       and (p_to_us is null or e.recorded_at <= timestamptz 'epoch' + p_to_us::bigint * interval '1 microsecond')
       and (p_after_id is null or e.id > p_after_id::bigint)
       and (p_up_to_id is null or e.id <= p_up_to_id::bigint)
       and (p_chain_key is not null or tab.chain_listed(e.chain_key, v_record, v_gov, v_withheld.chains))
       and not tab.entry_withheld(e.payload, v_withheld)
       -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): no controlled-substance entry for a reader who may not read it.
       and not tab.controlled_entry_hidden(v_reader, e.payload ->> 'table', e.payload ->> 'record_id')
     order by e.id
     limit greatest(coalesce(p_limit, 50), 0) + 1;
end
$$;

create or replace function tab.audit_chains(p_token_hash text, p_prefix text, p_limit integer)
returns table (chain_key text, last_seq text, us text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
begin
  return query
    with partly as (select * from tab.partly_withheld_chains(v_withheld))
    select h.chain_key,
           case when p.chain_key is null then coalesce(e.payload ->> 'seq', h.last_seq::text)
                else (coalesce((e.payload ->> 'seq')::bigint, h.last_seq) - p.withheld)::text end,
           case when e.id is null then null when p.chain_key is null then tab.audit_entry_us(e) else tab.audit_entry_us(s) end
      from kernel.audit_chain_head h
      left join kernel.audit_event e on e.chain_key = h.chain_key and e.seq = h.last_seq and e.hash = h.last_hash and e.payload ->> 'chain_key' = h.chain_key
      left join partly p on p.chain_key = h.chain_key
      left join kernel.audit_event s on s.id = p.last_shown
     where (coalesce(p_prefix, '') = '' or starts_with(h.chain_key, p_prefix))
       and tab.chain_listed(h.chain_key, v_record, v_gov, v_withheld.chains)
       and (p.chain_key is null or p.last_shown is not null)
       -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): no controlled chain the reader may not read.
       and tab.controlled_aggregate_problem(v_reader, split_part(h.chain_key, ':', 1), substr(h.chain_key, length(split_part(h.chain_key, ':', 1)) + 2)) is null
     order by case when e.id is null then null else coalesce(s.id, e.id) end desc nulls last
     limit greatest(coalesce(p_limit, 500), 0);
end
$$;

create or replace function tab.audit_headless_chains(p_token_hash text, p_prefix text)
returns table (chain_key text, entries bigint)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
begin
  return query
    with recursive k (key) as (
      (select e.chain_key from kernel.audit_event e order by e.chain_key limit 1)
      union all
      select (select e.chain_key from kernel.audit_event e where e.chain_key > k.key order by e.chain_key limit 1)
        from k where k.key is not null
    )
    select c.key, c.n
      from (select k.key, (select count(*) from kernel.audit_event e where e.chain_key = k.key and not tab.entry_withheld(e.payload, v_withheld)) as n
              from k
             where k.key is not null
               and not exists (select 1 from kernel.audit_chain_head h where h.chain_key = k.key)
               and (coalesce(p_prefix, '') = '' or starts_with(k.key, p_prefix))
               and tab.chain_listed(k.key, v_record, v_gov, v_withheld.chains)
               -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): no controlled chain the reader may not read.
               and tab.controlled_aggregate_problem(v_reader, split_part(k.key, ':', 1), substr(k.key, length(split_part(k.key, ':', 1)) + 2)) is null) c
     where c.n > 0
     order by c.key collate "C";
end
$$;

create or replace function tab.controlled_register_extracts(p_token_hash text, p_extract uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_r tab.reader := tab.reader_of(p_token_hash);
begin
  -- Phase 7 slice 7a review (tablets 1415): an export carries no site and covers the material's lots at every site and
  -- every product (recipe.controlled_register_v1), so it is read in the scope {} it is run in (recipe-core 1034).
  perform tab.controlled_reader_refusal(v_r, null, null);
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

revoke all on function tab.controlled_aggregate_problem(tab.reader, text, text), tab.controlled_entry_hidden(tab.reader, text, text) from public;

reset role;
