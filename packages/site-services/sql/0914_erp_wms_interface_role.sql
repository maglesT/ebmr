-- Site services: the ERP/WMS adapter's role, and issue as a person's act (Phase 6 slice 6a, builder A; DI-14, DI-20,
-- DI-31, PR-17; D-P6a-0-2, D-P6a-A-12).
--
-- Handbook: modules/site-services.md
--
--   * Role ERP_WMS_INTERFACE (INTEGRATION accounts only): what the ERP_WMS adapter's receiving command needs, and only
--     that: INTERFACE.WRITE (the inbound framework, kernel 1180), ERP.MASTER_WRITE (masters and production orders,
--     0802) and MATERIAL.HANDLE (a WMS goods receipt creates its lots in QUARANTINE, whose machine creates under
--     MATERIAL.HANDLE, 0711). It holds no SIGN or ACKNOWLEDGE permission, so it can never release, sign or acknowledge
--     (DI-14, kernel 0120 to 0160). The site's ERP_WMS adapter is registered with an account holding this role (D-P6a-0-1);
--     ERP_INTERFACE stays for the ERP import and the shipping stub of Phase 4.
--   * Because the role carries MATERIAL.HANDLE, issue is made a person's act in the database: a reservation and a
--     consumption are refused unless the account that writes them is a HUMAN account (trigger zz_issue_by_person on
--     site.lot_reservation and site.lot_consumption; EBMR-SITE-924). The adapter receives and moves stock as the WMS
--     reports it; it never issues it.
--
-- Messages: EBMR-SITE-924.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0914_erp_wms_interface_role)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the ERP/WMS adapter role (DI-20, DI-31; Phase 6 slice 6a)'));

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('ERP_WMS_INTERFACE', 'ERP/WMS adapter', 'MASTER_RECORDS',
   'The ERP/WMS integration adapter: posts masters, production orders, goods receipts, stock moves and lot statuses as inbound messages; never signs, never issues, never logs in interactively',
   array['INTEGRATION'], false);
insert into iam.role_permission (role_code, permission_code) values
  ('ERP_WMS_INTERFACE', 'INTERFACE.WRITE'),
  ('ERP_WMS_INTERFACE', 'ERP.MASTER_WRITE'),
  ('ERP_WMS_INTERFACE', 'MATERIAL.HANDLE');

select kernel.set_actor_context(null);

create function site.issue_by_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_account uuid;
  v_kind    text;
begin
  if tg_table_name = 'lot_reservation' then
    v_account := new.reserved_by_account;
  else
    v_account := new.consumed_by_account;
  end if;
  select a.kind into v_kind from iam.account a where a.id = v_account;
  if v_kind is distinct from 'HUMAN' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-924 material is reserved and issued by a person; a %s account never issues stock (DI-14, PR-17)', coalesce(v_kind, 'unknown'));
  end if;
  return new;
end
$$;

create trigger zz_issue_by_person before insert on site.lot_reservation for each row execute function site.issue_by_person();
create trigger zz_issue_by_person before insert on site.lot_consumption for each row execute function site.issue_by_person();

reset role;
