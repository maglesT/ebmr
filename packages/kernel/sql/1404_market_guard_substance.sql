-- API edition plan A1a (lead clearance of 5 November 2026): the market guard of kernel 0330 fails closed for the API
-- edition. market.evaluate_stub_scope refused a tablets key on an injectables scope and a sterile key on a tablets scope,
-- but a substance scope could evaluate any table's key (a tablets or sterile rule would then apply to an API batch). It
-- now refuses every key outside the kernel table on a substance scope (the API edition binds the kernel table only,
-- recipe-core 1872 recipe.rule_table_versions), with the same message EBMR-MKT-054.
--
-- Handbook: modules/kernel.md
--
--   market.evaluate_stub_scope: CREATE OR REPLACE from its only definition (0330) with that one added condition. Nothing
--   else changes; CREATE OR REPLACE keeps the owner and grants.

set local role ebmr_owner;

create or replace function market.evaluate_stub_scope(p_req jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_key     text := p_req ->> 'key';
  v_table   text := market.table_of_key(p_req ->> 'key');
  v_kind    text := p_req -> 'scope' ->> 'kind';
  v_scope   jsonb;
  v_pred    jsonb;
  v_extra   jsonb := coalesce(p_req -> 'predicates', '{}'::jsonb);
  v_attr    text;
  v_stated  jsonb := market.nz(p_req -> 'stated', null);
  v_site    uuid;
  v_subject jsonb;
begin
  -- DI-18, then DI-17 where the actor works (point-of-work action: the session's site and room).
  perform iam.assert_not_administrator();
  perform iam.require_permission('MARKET.RULE_EVALUATE', iam.actor_location_scope());
  if v_table is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-041 key %s belongs to no rule table', coalesce(v_key, '(missing)'));
  end if;
  if v_kind is distinct from 'MATERIAL_LOT' and market.nz(p_req -> 'consumingBatchId', null) is not null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-052 only a MATERIAL_LOT scope is resolved against a consuming batch; a %s scope names none', coalesce(v_kind, '(missing)'));
  end if;
  v_scope := market.scope_markets(v_kind, (p_req -> 'scope' ->> 'id')::uuid, v_table, (p_req ->> 'consumingBatchId')::uuid);
  if (v_table = 'tablets' and v_scope ->> 'edition' = 'injectables') or (v_table = 'sterile' and v_scope ->> 'edition' = 'tablets')
     or (v_table is distinct from 'kernel' and v_scope ->> 'edition' = 'substance') then
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
  -- The site value applied is the one of the site the scope fixes (a batch's own site). A request may
  -- name it again, but a different site, an unknown id or an explicit null is refused (F21, F80).
  v_site := market.try_uuid(v_scope ->> 'siteId');
  if p_req ? 'siteId'
     and (jsonb_typeof(p_req -> 'siteId') not in ('string', 'null')
          or (jsonb_typeof(p_req -> 'siteId') = 'string' and market.try_uuid(p_req ->> 'siteId') is null)
          or market.try_uuid(p_req ->> 'siteId') is distinct from v_site) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-056 the site of this evaluation is the site its scope fixes (%s); a request cannot name another one (%s)',
      coalesce(v_site::text, 'none'), (p_req -> 'siteId')::text);
  end if;
  -- A PACK scope resolves a PER_DESTINATION key for its own destination, never another (F23).
  if v_scope ->> 'destination' is not null and jsonb_typeof(v_stated) = 'object' then
    if (v_stated ->> 'destination') is not null and (v_stated ->> 'destination') <> (v_scope ->> 'destination') then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-057 pack %s goes to %s; its label rules are resolved for that destination, not for %s',
        v_scope ->> 'scopeId', v_scope ->> 'destination', v_stated ->> 'destination');
    end if;
    v_stated := v_stated || jsonb_build_object('destination', v_scope ->> 'destination');
  end if;
  v_subject := market.stub_evaluation_subject(v_scope, market.nz(p_req -> 'subject', null));
  return market.record_evaluation(jsonb_build_object(
    'key', v_key, 'tableVersionId', p_req -> 'tableVersionId', 'scope', p_req -> 'scope',
    'consumingBatchId', p_req -> 'consumingBatchId', 'subject', v_subject, 'resolutionPoint', p_req -> 'resolutionPoint',
    'asOf', p_req -> 'asOf', 'markets', v_scope -> 'markets', 'marketDerivation', v_scope -> 'derivation', 'predicates', v_pred,
    'stated', v_stated, 'siteId', to_jsonb(v_site)));
end
$$;

reset role;
