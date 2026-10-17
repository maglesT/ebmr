-- Site services: a person's material acts stay a person's acts when an integration account holds MATERIAL.HANDLE
-- (Phase 6 review 6j-c, finding R1; DI-14, DI-20).
--
-- Handbook: modules/site-services.md
--
--   Site services 0914 gave the ERP_WMS adapter's role (INTEGRATION accounts only) MATERIAL.HANDLE, so that a WMS
--   goods receipt can create its lots, and made issue (reservation, consumption) a person's act with the trigger
--   zz_issue_by_person. Every other command gated on MATERIAL.HANDLE was still open to the adapter's identity: it could
--   cancel a person's reservation, record a destruction, recover returned goods, receive returns, post a finished lot,
--   and prepare, seal or import a transfer package (slice 6i). None of these is what the WMS reports.
--   The trigger zz_material_act_by_person (before insert) refuses a row of these acts unless the account that writes it
--   (the column named by the trigger's argument) is a HUMAN account. The WMS path (lots and receipts of a goods receipt,
--   stock moves, lot statuses, shipments) writes none of these tables and is unchanged.
--
-- Messages: EBMR-SITE-925.

set local role ebmr_owner;

create function site.material_act_by_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_account uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  v_kind    text;
begin
  select a.kind into v_kind from iam.account a where a.id = v_account;
  if v_kind is distinct from 'HUMAN' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-925 %s is a person''s material act; a %s account never records it (DI-14, DI-20)',
                       tg_table_name, coalesce(v_kind, 'unknown'));
  end if;
  return new;
end
$$;
revoke all on function site.material_act_by_person() from public;

create trigger zz_material_act_by_person before insert on site.lot_reservation_revocation
  for each row execute function site.material_act_by_person('revoked_by_account');
create trigger zz_material_act_by_person before insert on site.lot_destruction
  for each row execute function site.material_act_by_person('performed_by_account');
create trigger zz_material_act_by_person before insert on site.chemical_recovery
  for each row execute function site.material_act_by_person('recorded_by_account');
create trigger zz_material_act_by_person before insert on site.returned_goods
  for each row execute function site.material_act_by_person('received_by_account');
create trigger zz_material_act_by_person before insert on site.finished_lot
  for each row execute function site.material_act_by_person('posted_by_account');
create trigger zz_material_act_by_person before insert on site.transfer_package
  for each row execute function site.material_act_by_person('prepared_by_account');
create trigger zz_material_act_by_person before insert on site.transfer_package_seal
  for each row execute function site.material_act_by_person('sealed_by_account');
create trigger zz_material_act_by_person before insert on site.transfer_receipt
  for each row execute function site.material_act_by_person('received_by_account');

reset role;
