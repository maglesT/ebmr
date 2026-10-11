-- Material lots: a batch that ends gives back its open reservations (Phase 3 exit review HIGH-4; outline 5.2.9;
-- controls INV-13, INV-14 input side).
--
-- A reservation held stock for its batch until its own expiry, consumption to zero, a cancellation by stores or the lot
-- leaving a usable status. A batch that completed, was aborted or cancelled kept its open reservations, so stock stayed
-- held for a batch that can consume nothing more (recipe-core 0700 refuses a consumption into a batch not running).
--
--   * site.lot_reservation_revocation.kind also takes BATCH_ENDED.
--   * site.revoke_batch_reservations(batch, cause): one BATCH_ENDED revocation for every not yet revoked reservation of
--     the batch, naming the cause and carrying the deciding person's reason as given; returns how many. Owner only:
--     the batch side calls it when the batch's stored status becomes EXECUTION_COMPLETE, ABORTED or CANCELLED
--     (recipe-core 0700); a batch with no open reservation needs no actor (nothing is written).

set local role ebmr_owner;

alter table site.lot_reservation_revocation drop constraint lot_reservation_revocation_kind_check;
alter table site.lot_reservation_revocation add constraint lot_reservation_revocation_kind_check
  check (kind in ('STATUS_CHANGE', 'CANCELLED', 'BATCH_ENDED'));

create function site.revoke_batch_reservations(p_batch uuid, p_cause text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_ctx jsonb;
  v_n   integer;
begin
  if not exists (select 1 from site.lot_reservation r
                  where r.batch_id = p_batch and not exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id)) then
    return 0;
  end if;
  v_ctx := site.require_actor();
  insert into site.lot_reservation_revocation (reservation_id, kind, cause, reason_code, reason_text, revoked_by_person, revoked_by_account)
  select r.id, 'BATCH_ENDED', p_cause, nullif(btrim(coalesce(v_ctx ->> 'reason_code', '')), ''), nullif(btrim(coalesce(v_ctx ->> 'reason_text', '')), ''),
         (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid
    from site.lot_reservation r
   where r.batch_id = p_batch and not exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke all on function site.revoke_batch_reservations(uuid, text) from public;

reset role;
