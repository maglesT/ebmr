-- SITE-995 (lead ruling of 11 November 2026, owner: minimum compliance): an in-house intermediate lot of the API edition
-- may carry a retest date, or neither date, instead of an expiry date. ICH Q7 (EU GMP Part II) 11.6 paraphrased: an
-- expiry or retest date is needed where an intermediate leaves the manufacturer's own material control; within it the
-- firm decides, so the record keeps only the dates the firm actually set. Received lots, finished lots and every other
-- kind keep their expiry date, as before.
--
-- Handbook: modules/site-services.md
--
--   site.material_lot.expires_at  nullable. Check material_lot_expiry_or_intermediate: only a lot of kind INTERMEDIATE
--                           may have none; constraint trigger zz_expiry_in_house (deferred, so the post's site.intermediate_lot
--                           row is in place at commit): a lot without an expiry is an in-house intermediate, i.e. it has
--                           a site.intermediate_lot row (EBMR-SITE-999). The existing check that a retest date is on or
--                           before the expiry still holds when both are set.
--   site.create_intermediate_lot(p)  as 1734, with the dates optional: expiresAt and retestAt each given or not; when both
--                           are, the retest date is on or before the expiry (EBMR-SITE-998). EBMR-SITE-995 is now the
--                           quantity's refusal only.
--   site.transfer_package   trigger a0_lot_has_expiry: a package is never prepared for a lot without an expiry date
--                           (EBMR-XFR-043). The receiving site records the lot as a received lot, which always carries an
--                           expiry (and ICH Q7 11.6, paraphrased, asks for a date on an intermediate that leaves the firm's
--                           own control); the package's hold limit (0980) is computed from that expiry.
-- Unchanged by design: a reservation of a lot without an expiry (site.reserve_lot, 0752) is bounded by the lot's retest date
-- when it has one, otherwise only by the reservation's own end the caller gives; there is no expiry to cap it. A certificate
-- of analysis (substance 5005) is issued only for a finished API lot, and the check above keeps every finished lot dated.
-- Messages: EBMR-SITE-993 to EBMR-SITE-995 and EBMR-SITE-997 (unchanged), EBMR-SITE-998, EBMR-SITE-999, EBMR-XFR-043.

set local role ebmr_owner;

alter table site.material_lot alter column expires_at drop not null;
alter table site.material_lot add constraint material_lot_expiry_or_intermediate
  check (expires_at is not null or material_kind = 'INTERMEDIATE');

-- Basis: record integrity of the lot's dates (PR-18): only the API edition's own post makes a lot without an expiry.
create function site.material_lot_no_expiry_in_house() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if new.expires_at is null and not exists (select 1 from site.intermediate_lot i where i.lot_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-999 lot %s has no expiry date: only an intermediate lot made in-house (posted from its batch) may carry a retest date or no date instead (PR-18)', new.lot_code);
  end if;
  return null;
end
$$;
revoke all on function site.material_lot_no_expiry_in_house() from public;

create constraint trigger zz_expiry_in_house after insert or update on site.material_lot
  deferrable initially deferred for each row when (new.expires_at is null)
  execute function site.material_lot_no_expiry_in_house();

-- Internal (no grant to the application role): the API edition's definer posts its processing batch's output.
-- p: {batchId, productName, quantity (decimal text), unit, expiresAt?, retestAt?}.
create or replace function site.create_intermediate_lot(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_id    uuid := gen_random_uuid();
  v_batch uuid;
  v_b     jsonb;
  v_f     jsonb;
  v_exp   timestamptz;
  v_rt    timestamptz;
  v_n     bigint;
  v_code  text;
begin
  -- Basis: segregation of duties (an administrator never makes a GMP entry; the act is a person's, 0990).
  perform iam.assert_not_administrator();
  v_batch := case when coalesce(p ->> 'batchId', '') ~ '^[0-9a-fA-F-]{36}$' then (p ->> 'batchId')::uuid end;
  v_b := site.subject_identity('BATCH', v_batch);
  -- Basis: record integrity (AS-03): an intermediate lot traces to a GMP batch of the register, never to a stray id.
  if v_b is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-993 batch %s is not a GMP batch of this installation: an intermediate lot is posted only from its batch (AS-03)', coalesce(p ->> 'batchId', 'NULL'));
  end if;
  -- Basis: 21 CFR 11.10(d) and Annex 11 clause 12 paraphrased (only authorised persons act): MATERIAL.HANDLE at the batch's site.
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_b ->> 'siteCode'));
  if v_b ->> 'siteCode' is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-993 an intermediate lot is posted at its batch''s site';
  end if;
  v_f := site.intermediate_batch_facts(v_batch);
  -- Basis: AS-03, AS-16 (an intermediate comes from a processing step whose record is complete) and engine integrity
  -- (a tablets or injectables batch posts a finished lot, never an intermediate).
  if v_b ->> 'edition' is distinct from 'SUBSTANCE' or v_f ->> 'familyEdition' is distinct from 'substance'
     or v_f ->> 'recordKind' is distinct from 'PROCESSING' or v_f ->> 'status' is distinct from 'EXECUTION_COMPLETE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-994 batch %s is a %s %s batch of edition %s: an intermediate lot is posted only from a processing batch of the API edition whose execution is complete (AS-03, AS-16)',
                       v_b ->> 'batchNumber', coalesce(v_f ->> 'recordKind', 'unknown'), coalesce(v_f ->> 'status', 'not started'), coalesce(v_b ->> 'edition', 'none'));
  end if;
  -- Basis: record integrity (INV-13): a posted quantity is a positive decimal, never a float or zero.
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'quantity')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-995 the posted quantity of an intermediate lot is a positive decimal (INV-13)';
  end if;
  v_exp := (p ->> 'expiresAt')::timestamptz;
  v_rt := (p ->> 'retestAt')::timestamptz;
  -- Basis: record integrity of the lot's dates (PR-18; the material-lot check of 0710): an in-house intermediate carries
  -- an expiry date, a retest date, both or neither, as the firm set them; a retest date is never after the expiry.
  if v_rt is not null and v_exp is not null and v_rt > v_exp then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-998 the retest date of an intermediate lot (%s) is on or before its expiry date (%s) (PR-18)', site.utc_text(v_rt), site.utc_text(v_exp));
  end if;
  -- The batch's next lot number (INV-27): drawn under the per-batch lock, so concurrent posts are serialised.
  perform pg_advisory_xact_lock(hashtext('site.intermediate_lot'), hashtext(v_batch::text));
  -- The next FREE number: from the count of the batch's lots plus one, past any code another lot already holds at the site
  -- (a received lot that happens to carry <batch>-N), so a code is never reused and the batch can always post.
  select count(*) + 1 into v_n from site.intermediate_lot i where i.batch_id = v_batch;
  loop
    v_code := case when v_n = 1 then v_b ->> 'batchNumber' else (v_b ->> 'batchNumber') || '-' || v_n::text end;
    exit when not exists (select 1 from site.material_lot l where l.site_code = v_b ->> 'siteCode' and l.lot_code = v_code);
    v_n := v_n + 1;
  end loop;
  begin
    insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at,
                                 received_by_person, received_by_account, correlation_id)
  values (v_id, v_b ->> 'siteCode', v_code, v_b ->> 'productCode', coalesce(nullif(btrim(p ->> 'productName'), ''), v_b ->> 'productCode'),
          'INTERMEDIATE', (p ->> 'quantity')::numeric, p ->> 'unit', v_rt, v_exp,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  exception when unique_violation then
    -- Basis: record integrity (one code names one lot at a site): only a race with a lot received outside this lock, or
    -- an unexpected clash, reaches the unique (site, lot code) of site.material_lot (0710); refused by name.
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-997 lot code %s, the next intermediate lot of batch %s, was taken by another lot at site %s meanwhile: one code names one lot (INV-27); post again',
                       v_code, v_b ->> 'batchNumber', v_b ->> 'siteCode');
  end;
  insert into site.intermediate_lot (lot_id, batch_id, batch_number, edition, product_code, strength, posted_by_person, posted_by_account)
  values (v_id, v_batch, v_b ->> 'batchNumber', v_b ->> 'edition', v_b ->> 'productCode', v_b ->> 'strength',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return v_id;
end
$$;

-- Basis: ICH Q7 (EU GMP Part II) 11.6 paraphrased (an intermediate leaving the firm's own material control carries an
-- expiry or retest date) and record integrity of the receiving site's lot, which is a received lot and always records an
-- expiry (PR-18; 0981 refuses a package without one). The dates of an in-house intermediate are set only at its post, so
-- a lot posted without an expiry stays at its site.
create function site.transfer_package_lot_has_expiry() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_code text;
begin
  select l.lot_code into v_code from site.material_lot l where l.id = new.lot_id and l.expires_at is null;
  if found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-043 lot %s has no expiry date, so it cannot be sent to another site: the receiving site records every lot it receives with its expiry date, and an intermediate leaving the firm''s own control carries a date (ICH Q7 11.6; PR-18). Keep it at this site; an in-house intermediate''s dates are set when it is posted', v_code);
  end if;
  return new;
end
$$;
revoke all on function site.transfer_package_lot_has_expiry() from public;

create trigger a0_lot_has_expiry before insert on site.transfer_package
  for each row execute function site.transfer_package_lot_has_expiry();

reset role;
