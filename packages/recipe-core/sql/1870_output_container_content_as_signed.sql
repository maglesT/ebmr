-- Issue #95 (DI-22, INV-09): the second person's verification of a typed container close (meaning VERIFIED) keeps the
-- content it signed. Since 0740 the content of output_container:<id> held net_verified_by and net_verified_at, and its
-- content version counted the verification: the verification itself then changed the content its own signature stood
-- over (esig.verify_signatures: CONTENT_CHANGED_WITHOUT_INVALIDATION). Who verified and when are the signature's own
-- (signer, recorded_at, manifestation) and the verification row's; the content and its version leave them out. Every
-- other member is as in 0740. A VERIFIED signature made before this signed the two members as null and stays reported.
--
-- Handbook: modules/recipe-core.md

set local role ebmr_owner;

create or replace function plant.output_container_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  c       plant.output_container;
  x       plant.container_close;
  v_holds jsonb;
  v_by    jsonb;
  v_body  jsonb;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from plant.output_container where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into x from plant.container_close where container_id = c.id;
  select coalesce(jsonb_agg(jsonb_build_object('ipc_check_id', k.id, 'result', k.result, 'press', k.press_code, 'stream', k.stream,
                                               'reference', k.reference, 'recorded_at', k.recorded_at, 'via_container_id', h.via_container_id)
                            order by h.recorded_at, h.id), '[]'::jsonb)
    into v_holds
    from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id;
  select coalesce(jsonb_agg(distinct p), '[]'::jsonb) into v_by
    from (select c.opened_by_person as p union all select x.person_id
          union all select k.person_id from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id) x
   where p is not null;
  v_body := jsonb_build_object('label_code', c.label_code, 'batch_id', c.batch_id, 'batch_number', c.batch_number,
                               'product_code', c.product_code, 'strength', c.strength, 'stage', c.stage, 'press_code', c.press_code,
                               'stream', c.stream, 'net_quantity', x.net_quantity::text, 'quantity_unit', c.quantity_unit,
                               'opened_at', c.opened_at, 'closed_at', x.closed_at, 'holds', v_holds);
  -- 0740: a close with a basis shows it (closes before 0740 read as before, so their signatures keep their content).
  -- Issue #95: not who verified the net and when: that is the VERIFIED signature itself, and its content stays as signed.
  if x.basis is not null then
    v_body := v_body || jsonb_build_object('close_basis', x.basis, 'closed_by', x.person_id, 'weighing', x.weighing);
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (case when x.container_id is null then 0 else 1 end) + jsonb_array_length(v_holds),
    'content', v_body,
    'state', plant.container_state(c.id),
    'scope', jsonb_build_object('product', c.product_code),
    'entered_by', v_by);
end
$$;

reset role;
