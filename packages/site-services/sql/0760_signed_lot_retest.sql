-- The retest decision of a material lot under QC's own e-signature (Phase 3 slice 6a; signable action QUALITY_ACT
-- LOT_RETEST; controls PR-18, IN-24 (a)(b); DI-35: a GMP decision is signed by the person who takes it).
--
-- site.record_lot_retest (0752) records QC's decision of a new retest instant without a signature. Over HTTP the decision
-- is a signed act:
--   meaning LOT_RETEST_APPROVED     QC.RESULT_APPROVE: "I set this lot's new retest date on the approved retest results named"
--   site.record_signed_lot_retest(lot, at, results, signature)
--                                   the signature is a valid LOT_RETEST_APPROVED signature of the actor on the lot
--                                   (aggregate material_lot, the lot's current content), then site.record_lot_retest decides
--                                   everything else as before (EBMR-SITE-180 to 185). The server records a retest only this
--                                   way; the unsigned writer of 0752 stays as it was (its own tests use it).
-- Messages: EBMR-SITE-190.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0760_signed_lot_retest)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'signed retest decision of a material lot (PR-18; slice 6a)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('LOT_RETEST_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'LABORATORY', 'APPROVER', 'Material lot retest date set by QC',
   'I set this material lot''s new retest date on the approved, passing retest results named.',
   array['QC.RESULT_APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.9 (retest); PR-18; IN-24 (a)(b)');

select kernel.set_actor_context(null);

create function site.record_signed_lot_retest(p_lot uuid, p_retest_at timestamptz, p_results uuid[], p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_sig jsonb;
begin
  if p_signature is null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-190 a retest decision is signed LOT_RETEST_APPROVED by the QC person who takes it (PR-18, DI-35)';
  end if;
  v_sig := esig.assert_signature(p_signature, 'LOT_RETEST_APPROVED', 'material_lot', p_lot::text);
  if (v_sig ->> 'signer_person') is distinct from (v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-190 a retest decision is recorded by the QC person who signed it (PR-18, DI-35)';
  end if;
  return site.record_lot_retest(p_lot, p_retest_at, p_results);
end
$$;

revoke all on function site.record_signed_lot_retest(uuid, timestamptz, uuid[], uuid) from public;
grant execute on function site.record_signed_lot_retest(uuid, timestamptz, uuid[], uuid) to ebmr_app;

reset role;
