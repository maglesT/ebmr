-- Site services: chemical recovery of returned goods, with its genealogy link (Phase 6 slice 6d; controls IN-29, PR-57,
-- PR-48; closes the residual of Phase 4 default D-2b-6; defaults D-P6d-0-4 and D-P6d-0-5 in
-- docs/build-plan/phase-6/slice-6d-0-interfaces.md).
--
-- Handbook: modules/site-services.md
--
--   site.chemical_recovery   insert-only, audited (aggregate material_lot, keyed by the returned lot): returned goods whose
--                            latest assessment QC signed with the disposition CHEMICAL_RECOVERY (0842), turned into one
--                            new lot of recovered material, with the quantity of returned goods it took, the recovery
--                            procedure's reference and who recorded it. One recovery per returned lot (D-P6d-0-4). The row
--                            is the genealogy edge RECOVERED (recipe-core 1010): written in the transaction that creates the
--                            recovered lot, never afterwards.
--   site.record_chemical_recovery(returned lot, p) jsonb   MATERIAL.HANDLE at the lot's site, never an administrator:
--                            p {materialCode, materialName, quantity (decimal text), unit, expiresAt, retestAt?,
--                            processReference, returnedQuantity? (decimal text; all of the returned goods by default)}.
--                            The recovered material is a lot of kind INTERMEDIATE (made on site, so no supplier receipt
--                            applies, 0910) created in QUARANTINE: QC releases it through the ordinary lot release before
--                            any batch consumes it, and that consumption is the next genealogy edge (D-P6d-0-5).
--                            Refusals: EBMR-SITE-960 not returned goods of this site; -961 QC's signed assessment did not
--                            choose chemical recovery; -962 the returned goods are no longer in quarantine or rejected
--                            (destroyed, for instance); -963 already recovered; -964 the recovery record is incomplete;
--                            -965 more returned goods taken than were returned.
--
-- Messages: EBMR-SITE-960 to EBMR-SITE-965.

set local role ebmr_owner;

create table site.chemical_recovery (
  id                    uuid primary key default gen_random_uuid(),
  returned_lot_id       uuid not null unique references site.returned_goods (lot_id),
  recovered_lot_id      uuid not null unique references site.material_lot (id),
  assessment_id         uuid not null references site.returned_goods_assessment (id),
  returned_quantity     numeric not null check (returned_quantity > 0),
  returned_unit         text not null,
  process_reference     text not null check (btrim(process_reference) <> '' and length(process_reference) <= 200),
  recorded_by_person    uuid not null,
  recorded_by_account   uuid not null,
  correlation_id        uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  check (returned_lot_id <> recovered_lot_id)
);
revoke all on site.chemical_recovery from public;
grant select on site.chemical_recovery to ebmr_app;

create trigger aa_insert_only before update or delete on site.chemical_recovery for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on site.chemical_recovery for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('site.chemical_recovery', array['recorded_at']);
select kernel.register_audited_table('site.chemical_recovery', 'material_lot', 'returned_lot_id', true);

create function site.record_chemical_recovery(p_lot uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  l       site.material_lot;
  g       site.returned_goods;
  a       site.returned_goods_assessment;
  v_id    uuid := gen_random_uuid();
  v_code  text;
  v_taken numeric;
  dec     constant text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  perform iam.assert_not_administrator();
  select * into g from site.returned_goods where lot_id = p_lot;
  if g.lot_id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-960 lot %s is no returned goods; only returned goods are chemically recovered (PR-48, IN-29)', coalesce(p_lot::text, 'NULL'));
  end if;
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  if l.site_code is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-960 returned lot %s is recovered at its own site %s', l.lot_code, l.site_code);
  end if;
  if site.returned_goods_signed_disposition(l.id) is distinct from 'CHEMICAL_RECOVERY' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-961 returned lot %s is recovered only after QC signed an assessment choosing chemical recovery (its signed disposition is %s; PR-48)',
                       l.lot_code, coalesce(site.returned_goods_signed_disposition(l.id), 'none'));
  end if;
  if site.lot_state(l.id) not in ('QUARANTINE', 'REJECTED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-962 returned lot %s is %s; only returned goods still in quarantine or rejected for recovery are recovered', l.lot_code, site.lot_state(l.id));
  end if;
  if exists (select 1 from site.chemical_recovery x where x.returned_lot_id = l.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-963 returned lot %s is already recovered (one recovery per returned lot, D-P6d-0-4)', l.lot_code);
  end if;
  if p is null or jsonb_typeof(p) <> 'object'
     or coalesce(p ->> 'materialCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$' or btrim(coalesce(p ->> 'materialName', '')) = '' or length(p ->> 'materialName') > 200
     or jsonb_typeof(p -> 'quantity') is distinct from 'string' or (p ->> 'quantity') !~ dec or (p ->> 'quantity')::numeric <= 0
     or coalesce(p ->> 'unit', '') !~ '^[!-~]{1,32}$'
     or btrim(coalesce(p ->> 'processReference', '')) = '' or length(p ->> 'processReference') > 200
     or coalesce(p ->> 'expiresAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
     or (p ? 'retestAt' and coalesce(p ->> 'retestAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$')
     or (p ? 'returnedQuantity' and (jsonb_typeof(p -> 'returnedQuantity') is distinct from 'string' or (p ->> 'returnedQuantity') !~ dec or (p ->> 'returnedQuantity')::numeric <= 0)) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-964 a chemical recovery records the recovered material''s code and name, its quantity (decimal text) and unit, its expiry (and retest) as UTC instants, the recovery procedure''s reference and, when not all of it, the quantity of returned goods taken (IN-29)';
  end if;
  if (p ->> 'expiresAt')::timestamptz <= clock_timestamp() or (p ? 'retestAt' and (p ->> 'retestAt')::timestamptz > (p ->> 'expiresAt')::timestamptz) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-964 the recovered material expires in the future, and a retest falls on or before its expiry';
  end if;
  v_taken := coalesce((p ->> 'returnedQuantity')::numeric, g.quantity);
  if v_taken > g.quantity then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-965 the recovery takes %s %s of returned lot %s, which holds %s %s (INV-13)', v_taken, g.unit, l.lot_code, g.quantity, g.unit);
  end if;
  a := site.returned_goods_latest_assessment(l.id);
  v_code := left(l.lot_code, 36) || '-CR';
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at,
                                 received_by_person, received_by_account, correlation_id)
  values (v_id, l.site_code, v_code, p ->> 'materialCode', btrim(p ->> 'materialName'), 'INTERMEDIATE', (p ->> 'quantity')::numeric, p ->> 'unit',
          (p ->> 'retestAt')::timestamptz, (p ->> 'expiresAt')::timestamptz,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  insert into site.chemical_recovery (returned_lot_id, recovered_lot_id, assessment_id, returned_quantity, returned_unit, process_reference,
                                      recorded_by_person, recorded_by_account, correlation_id)
  values (l.id, v_id, a.id, v_taken, g.unit, btrim(p ->> 'processReference'),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  return jsonb_build_object('lotId', v_id, 'lotCode', v_code);
end
$$;

revoke all on function site.record_chemical_recovery(uuid, jsonb) from public;
grant execute on function site.record_chemical_recovery(uuid, jsonb) to ebmr_app;

reset role;
