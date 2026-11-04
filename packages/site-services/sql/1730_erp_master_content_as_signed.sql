-- Issue #95 (DI-22, DI-24, INV-09): an ERP master confirmation keeps the content it signed. The content of
-- erp_master:<kind>/<version> showed the values in effect *now* and the names of the values that differ from them. The
-- confirmation itself makes this version the one in effect, so its own signature then stood over changed content
-- (esig.verify_signatures: CONTENT_CHANGED_WITHOUT_INVALIDATION). The values in effect are now those in effect before
-- this version took effect (or, while it waits, the latest in effect): the same before and after the confirmation, and
-- unchanged by later versions. Every other member is as in 0802; a signature made before this keeps its hash (the first
-- version of a master had nothing in effect before it, then and now).
--
-- Handbook: modules/site-services.md

set local role ebmr_owner;

create or replace function site.erp_master_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  m      text[];
  v      jsonb;
  v_cur  jsonb;
  v_own  site.erp_master_effect;
begin
  m := regexp_match(coalesce(p_id, ''), '^(PRODUCT|MATERIAL)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  v := site.erp_master_version(m[1], m[2]::uuid);
  if v is null then
    return '{"exists": false}'::jsonb;
  end if;
  -- The values in effect before this version: the latest effect earlier than this version's own, never this version's.
  select * into v_own from site.erp_master_effect where version_id = m[2]::uuid;
  select site.erp_master_version(x.master_kind, x.version_id) -> 'values' into v_cur
    from site.erp_master_effect x
   where x.master_kind = m[1] and x.master_key = v ->> 'key' and x.version_id <> m[2]::uuid
     and (v_own.id is null or (x.effective_at, x.id::text) < (v_own.effective_at, v_own.id::text))
   order by x.effective_at desc, x.id desc limit 1;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'title', format('ERP %s master %s, ERP reference %s', lower(m[1]), v ->> 'key', v ->> 'erpReference'),
      'master_kind', m[1], 'key', v ->> 'key', 'version_id', m[2], 'erp_reference', v ->> 'erpReference', 'received_at', v ->> 'receivedAt',
      'received', v -> 'values', 'in_effect', v_cur,
      'changes', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v -> 'values') k
                            where v_cur is null or (v -> 'values' -> k) is distinct from (v_cur -> k)), '[]'::jsonb)),
    'state', site.erp_master_state(m[1], m[2]::uuid),
    'scope', '{}'::jsonb,
    'entered_by', jsonb_build_array(v ->> 'receivedBy'));
end
$$;

reset role;
