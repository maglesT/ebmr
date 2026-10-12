-- Recipe core: the reads of the release cockpit (Phase 4 slice 3a; contract ns/release.ts). Read-only definers so the
-- application role reads the finished lots, the decision and the disposition-screen facts (DI-12 incidents, PR-08
-- registration-relevant exceptions, PR-09 protocol batches, IN-03 post-change batches) without grants on the tables.
--
--   recipe.release_lots()            one row per finished lot: lot, batch, product, markets, lot status, release state.
--   recipe.release_lot_facts(lot)    jsonb: the decision (with its delegation and the PR-53 justifications), the open
--                                    incidents and DI blockers of the lot and its batches, the registration-relevant
--                                    exceptions, the protocol and post-change batches, the PR-53 switch and the gates.
--   recipe.grel_acknowledged(lot, market, epoch, person) text[]: the items the person acknowledged at that epoch.

set local role ebmr_owner;

create function recipe.release_lots()
returns table (lot_id uuid, lot_code text, batch_id uuid, batch_number text, product_code text, strength text, markets text[], lot_status text, state text)
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select f.lot_id, l.lot_code, f.batch_id, f.batch_number, f.product_code, f.strength, f.markets, site.lot_state(f.lot_id),
         recipe.manufacturer_release_state(f.lot_id)
    from site.finished_lot f join site.material_lot l on l.id = f.lot_id
   order by f.posted_at desc, f.lot_id
$$;

create function recipe.release_lot_facts(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, records, esig, platform, pg_temp as $$
declare
  d     recipe.manufacturer_release_decision := recipe.manufacturer_decision(p_lot);
  v_set uuid[] := recipe.release_batches(p_lot);
begin
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return null;
  end if;
  return jsonb_build_object(
    'decision', case when d.lot_id is null then null else jsonb_build_object(
      'decision', d.decision, 'person_id', d.person_id, 'role_code', d.role_code,
      'us', (extract(epoch from d.recorded_at) * 1000000)::numeric(20, 0)::text, 'signature_id', d.signature_id,
      'delegation_id', d.delegation_id, 'reason', d.reason, 'epoch', d.epoch, 'checklist_hash', d.checklist_hash) end,
    'justifications', (select coalesce(jsonb_agg(jsonb_build_object('deviation_id', j.deviation_id, 'text', j.justification, 'signature_id', j.signature_id)
                                                 order by j.recorded_at, j.id), '[]'::jsonb)
                         from recipe.open_investigation_justification j where j.lot_id = p_lot and j.market = 'IN'
                          and coalesce((esig.signature_state(j.signature_id) ->> 'valid')::boolean, false)),
    'incidents', (select coalesce(jsonb_agg(jsonb_build_object('incident_id', b.blocker_id, 'number', b.reference, 'severity', coalesce(b.severity, ''),
                                                               'status', b.status, 'assessed', not b.blocks_disposition) order by b.since, b.reference), '[]'::jsonb)
                    from (select 'material_lot' as k, p_lot::text as id union all select 'batch', x::text from unnest(v_set) x) s,
                         records.open_blockers(s.k, s.id) b where b.blocker_kind = 'INCIDENT'),
    'registration_relevant', (select coalesce(jsonb_agg(jsonb_build_object('batch_id', r.batch_id, 'exception_id', r.exception_id, 'title', r.title,
                                'deviation_ref', (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = r.batch_id and a.exception_id = r.exception_id
                                                    and a.act = 'DEVIATION_LINKED' limit 1)) order by r.batch_id, r.exception_id), '[]'::jsonb)
                                from recipe.exception_register r where r.batch_id = any (v_set) and r.registration_relevant),
    'open_investigation_path', platform.setting_text('release.open_investigation_path') = 'ON',
    'validation_batches', (select coalesce(jsonb_agg(jsonb_build_object('batch_id', x, 'batch_number', b.batch_number, 'purpose', recipe.batch_purpose(x),
                             'outcome', (select o.outcome from recipe.ppq_outcome o where o.batch_id = x order by o.recorded_at desc, o.id desc limit 1))), '[]'::jsonb)
                             from unnest(v_set) x join recipe.batch_execution b on b.id = x where recipe.batch_purpose(x) in ('PPQ', 'VALIDATION')),
    'post_change', (select coalesce(jsonb_agg(jsonb_build_object('batch_id', x, 'batch_number', b.batch_number,
                      'change_record', (select c.number from recipe.change_record c where c.id = recipe.post_change_record(x)),
                      'evaluated', exists (select 1 from recipe.post_change_evaluation e where e.batch_id = x))), '[]'::jsonb)
                      from unnest(v_set) x join recipe.batch_execution b on b.id = x where recipe.post_change_record(x) is not null),
    'gates', jsonb_build_object('release', to_jsonb(recipe.release_gate_problems(p_lot, 'RELEASE')), 'reject', to_jsonb(recipe.release_gate_problems(p_lot, 'REJECT'))));
end
$$;

create function recipe.grel_acknowledged(p_lot uuid, p_market text, p_epoch text, p_person uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(a.item_id order by a.item_id), '{}') from recipe.grel_acknowledgement a
   where a.lot_id = p_lot and a.market = p_market and a.epoch = p_epoch and a.person_id = p_person
$$;

revoke all on function recipe.release_lots(), recipe.release_lot_facts(uuid), recipe.grel_acknowledged(uuid, text, text, uuid) from public;
grant execute on function recipe.release_lots(), recipe.release_lot_facts(uuid), recipe.grel_acknowledged(uuid, text, text, uuid) to ebmr_app;

reset role;
