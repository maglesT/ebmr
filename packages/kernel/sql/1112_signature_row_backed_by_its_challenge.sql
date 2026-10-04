-- Electronic signatures: a signature row is what its challenge and its authentication event say, whoever inserts it
-- (Phase 2 exit, SQL mutation kill work: the same defect as D11 found elsewhere; invariant INV-10; controls DI-37,
-- DI-36; 21 CFR 11.70 and 11.200 in substance: a signature is linked to its record and made by its owner's own
-- authentication).
--
-- Who can write signature rows. Only the table owner (ebmr_owner, so owner-level code) and superusers hold INSERT on
-- esig.signature (0220 grants the application role SELECT only; the sandbox role mirrors it). The only owner-level code
-- that inserts one is esig.sign (0230), which takes every value from the challenge, the meaning type and the
-- authentication event it consumes.
--
-- Why. esig.signature_guard (0220) let a row in when the transaction-local setting esig.signing_challenge named the
-- row's challenge: esig.sign sets it just before its insert. Any role can set that setting with set_config, so for
-- owner-level code that knew the id of an open challenge it was no barrier: it could insert a signature naming any
-- signer, any content hash and any meaning wording for that challenge, with an authentication event nobody made, and
-- add a seal row (only the seal's presence is checked in the database). The test "even the table owner cannot insert a
-- signature outside esig.sign" only tried a row without the setting. This is the fault of D11 (the state history taken
-- on the engine flag), found here while looking for it elsewhere.
--
-- Now, whatever the setting says (it is still required, as before, and no longer suffices):
--   * the row names exactly the record (type, id, reference), content (version, hash), meaning (code, version),
--     signer (person, account), co-signature flag, session (id, person) and terminal of its challenge, and the meaning
--     title and text of that meaning type version (EBMR-ESIG-065);
--   * its authentication event is one of the signer's own (person and account), made for a signature bound to this
--     challenge on the challenge's terminal, with the method and components the row records, and consumed for a
--     signature in this same transaction (iam.auth_event_use, written by iam.consume_auth_event, which esig.sign calls
--     first) (EBMR-ESIG-066).
-- What it does not do: owner-level code can still write every row such a signature needs (a challenge, an
-- authentication event and its use, the signature, a seal), since it owns those tables; a seal it writes without the
-- server's key is found only by the seal check that verifySignatures (TypeScript) makes with the trusted key ring. The
-- guard holds a signature row to the rows it depends on, as kernel 1110 holds a state history row to its state row.
--
-- Same signature, language, owner (ebmr_owner), search_path (pg_temp last) and SECURITY DEFINER; the trigger of 0220
-- calls it by name and is kept. The rest of the function (identity, time, offset and manifestation set here, the id
-- register) is unchanged. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create or replace function esig.signature_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_ch   esig.challenge%rowtype;
  v_type esig.meaning_type%rowtype;
begin
  if coalesce(current_setting('esig.signing_challenge', true), '') <> new.challenge_id::text then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-060 INV-10: signatures are inserted only by the signing function esig.sign';
  end if;
  perform set_config('esig.signing_challenge', '', true);
  -- 1112: the row is what its challenge says.
  select * into v_ch from esig.challenge c where c.id = new.challenge_id;
  select * into v_type from esig.meaning_type t where t.code = new.meaning_code and t.version = new.meaning_version;
  if v_ch.id is null
     or (new.aggregate_type, new.aggregate_id, new.aggregate_ref, new.content_version, new.content_hash, new.meaning_code, new.meaning_version,
         new.signer_person, new.signer_account, new.cosignature, new.session_id, new.session_person, new.device_id,
         new.meaning_title, new.meaning_text)
        is distinct from
        (v_ch.aggregate_type, v_ch.aggregate_id, v_ch.aggregate_ref, v_ch.content_version, v_ch.content_hash, v_ch.meaning_code, v_ch.meaning_version,
         v_ch.signer_person, v_ch.signer_account, v_ch.cosignature, v_ch.session_id, v_ch.session_person, v_ch.device_id,
         v_type.title, v_type.meaning_text) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-065 INV-10: a signature names exactly the record, content, meaning, signer, session and terminal of its challenge';
  end if;
  -- 1112: and its authentication event was consumed for it in this transaction.
  if not exists (select 1
                   from iam.auth_event e
                   join iam.auth_event_use u on u.auth_event_id = e.id and u.use_kind = 'SIGNATURE' and u.xact_id = pg_catalog.pg_current_xact_id()
                  where e.id = new.auth_event_id and e.person_id = new.signer_person and e.account_id = new.signer_account
                    and e.device_id = new.device_id and e.purpose = 'SIGNATURE' and e.challenge_id = new.challenge_id
                    and e.method = new.auth_method and e.components = new.components_used) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-066 INV-10: a signature consumes, in its own transaction, an authentication event of its signer made for its challenge on its terminal';
  end if;
  new.id := gen_random_uuid();
  new.recorded_at := clock_timestamp();
  new.utc_offset := esig.utc_offset(new.recorded_at, new.site_zone);
  new.manifestation := esig.build_manifestation(new);
  new.manifestation_text := esig.manifestation_line(new.manifestation);
  insert into esig.signature_id_register (signature_id) values (new.id);
  return new;
end
$$;

reset role;
