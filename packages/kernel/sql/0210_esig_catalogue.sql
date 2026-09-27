-- Electronic signatures (B2), part 2: the closed, versioned catalogue of signature meanings (DI-35),
-- the inventory that maps every predicate-rule signature point to a catalogue type, and the
-- quality unit's configuration functions (company signature policy, e-signature policy values).
--
-- Each signature type defines:
--   permissions          who may sign: the identity module's permissions, evaluated at the instant
--                        of signing with the stored authority evaluation (INV-26);
--   meaning_text         what the signature means, paraphrased by us and shown in the manifestation;
--   independent_of       meanings whose earlier signers on the same record this signer must differ
--                        from, evaluated on the PERSON;
--   excludes_performers  INV-03 (generic): nobody who performed, entered data in or corrected the
--                        record may sign it (verifier, witness, checker, approver types);
--   excludes_involved    review and release types: nobody in the record's involvement set;
--   witness              WITNESSED rules (same device or a device in the same room, within the
--                        witness window, before the next step starts);
--   reauth               ALL_COMPONENTS (every signing needs every component) or SESSION_RELAXABLE
--                        (routine: the DI-38 relaxation may apply when QA switched it on). There is
--                        no acknowledgement-only type: every type is a full electronic signature.
-- The vendor (minimum) set is seeded here. Customers add their own types and may tighten, never
-- loosen, remove or disable a minimum type; every change is a new version (insert-only, audited).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------------------------

create table esig.meaning_type (
  code                 text not null check (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  version              integer not null check (version >= 1),
  origin               text not null check (origin in ('VENDOR', 'CUSTOMER')),
  is_minimum           boolean not null,
  status               text not null check (status in ('ACTIVE', 'RETIRED')),
  category             text not null check (category in ('MASTER_RECORD', 'BATCH_RECORD', 'EXECUTION', 'VERIFICATION', 'EXCEPTION',
                                                          'LOGBOOK', 'LABORATORY', 'REVIEW', 'RELEASE', 'RECORDS')),
  role_class           text not null check (role_class in ('PERFORMER', 'VERIFIER', 'WITNESS', 'SUPERVISOR', 'AUTHORISER', 'APPROVER',
                                                            'REVIEWER', 'RELEASE')),
  title                text not null check (btrim(title) <> ''),
  meaning_text         text not null check (btrim(meaning_text) <> ''),
  permissions          text[] not null check (cardinality(permissions) >= 1),
  independent_of       text[] not null default '{}',
  excludes_performers  boolean not null,
  excludes_involved    boolean not null,
  witness              boolean not null,
  reauth               text not null check (reauth in ('ALL_COMPONENTS', 'SESSION_RELAXABLE')),
  delegable            boolean not null default false,
  sources              text not null check (btrim(sources) <> ''),
  defined_by_person    uuid,
  defined_by_account   uuid,
  reason               text,
  recorded_at          timestamptz not null default clock_timestamp(),
  primary key (code, version),
  check ((origin = 'VENDOR') = is_minimum),
  check (not is_minimum or status = 'ACTIVE'),
  -- DI-38: the relaxation never applies to master-record approval, dispositions or certification.
  check (category not in ('MASTER_RECORD', 'RELEASE') or reauth = 'ALL_COMPONENTS'),
  check (role_class <> 'RELEASE' or reauth = 'ALL_COMPONENTS'),
  check (not witness or role_class = 'WITNESS'),
  -- INV-03 is structural: every verifier or witness type excludes performers, enterers and correctors;
  -- every release type excludes the involvement set (outline 7.2 S10).
  check (role_class not in ('VERIFIER', 'WITNESS') or excludes_performers),
  check (role_class <> 'RELEASE' or excludes_involved),
  check (origin = 'VENDOR' or (defined_by_person is not null and defined_by_account is not null and btrim(coalesce(reason, '')) <> ''))
);

-- Versions follow each other; a minimum type is never removed, disabled or loosened; the vendor set
-- comes only from migrations, customer types only from attributed commands. A migration runs either
-- without an actor or as the software-release pipeline identity (role SOFTWARE_RELEASE, source
-- SYSTEM, nil person), which only owner-level code can install (kernel.set_actor_context): a command
-- started by kernel.begin_command can never carry it, because that role is granted to nobody.
create function esig.meaning_type_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_prev    esig.meaning_type%rowtype;
  v_actor   jsonb := kernel.current_actor();
  v_release boolean;
  v_perm    text;
begin
  v_release := v_actor is null
               or (v_actor ->> 'role_code' = 'SOFTWARE_RELEASE' and v_actor ->> 'source' = 'SYSTEM'
                   and v_actor ->> 'person_id' = '00000000-0000-0000-0000-000000000000');
  new.recorded_at := clock_timestamp();
  foreach v_perm in array new.permissions loop
    if not exists (select 1 from iam.permission p where p.code = v_perm and p.domain in ('GMP', 'GOVERNANCE') and p.effect in ('SIGN', 'WRITE')) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-025 %s is not a GMP signing or data-entry permission of the identity catalogue', v_perm);
    end if;
  end loop;
  if new.code = any (new.independent_of) then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-025 a type cannot be independent of itself';
  end if;
  select * into v_prev from esig.meaning_type where code = new.code order by version desc limit 1;
  if v_prev.code is null then
    if new.version <> 1 then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-021 the first version of %s is version 1', new.code);
    end if;
    if v_release and new.origin <> 'VENDOR' then
      raise exception using errcode = 'P0001', message = 'EBMR-ESIG-020 customer signature types are added through esig.add_meaning_type';
    end if;
    if not v_release and new.origin <> 'CUSTOMER' then
      raise exception using errcode = 'P0001', message = 'EBMR-ESIG-020 the minimum (vendor) set of signature types is defined only by migrations';
    end if;
    return new;
  end if;
  if v_actor is null then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-020 a new version of %s is an attributed command', new.code);
  end if;
  if new.version <> v_prev.version + 1 then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-021 the next version of %s is %s', new.code, v_prev.version + 1);
  end if;
  if new.origin <> v_prev.origin or new.is_minimum <> v_prev.is_minimum then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-021 the origin and minimum flag of %s never change', new.code);
  end if;
  if v_prev.status = 'RETIRED' then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-021 %s is retired; define a new type instead', new.code);
  end if;
  if v_prev.is_minimum then
    if new.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-022 %s belongs to the minimum set and cannot be removed or disabled', new.code);
    end if;
    if new.title <> v_prev.title or new.meaning_text <> v_prev.meaning_text or new.category <> v_prev.category
       or new.role_class <> v_prev.role_class or new.sources <> v_prev.sources then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-023 the meaning of minimum type %s is fixed', new.code);
    end if;
    if (v_prev.reauth = 'ALL_COMPONENTS' and new.reauth <> 'ALL_COMPONENTS')
       or (v_prev.excludes_performers and not new.excludes_performers)
       or (v_prev.excludes_involved and not new.excludes_involved)
       or (v_prev.witness and not new.witness)
       or (not v_prev.delegable and new.delegable)
       or not (new.independent_of @> v_prev.independent_of) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-024 %s belongs to the minimum set: its independence, re-authentication, witness and delegation rules can only be tightened', new.code);
    end if;
  end if;
  return new;
end
$$;
create trigger aa_meaning_type_guard before insert on esig.meaning_type for each row execute function esig.meaning_type_guard();

-- The vendor minimum set. Meaning texts are our own wording; sources cite clauses, never quote them.
insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
select s.code, 1, 'VENDOR', true, 'ACTIVE', s.category, s.role_class, s.title, s.meaning_text, s.permissions, s.independent_of,
       s.excludes_performers, s.excludes_involved, s.role_class = 'WITNESS', s.reauth, s.delegable, s.sources
from (values
  -- Master records
  ('PREPARED', 'MASTER_RECORD', 'PERFORMER', 'Prepared', 'I prepared this master document.',
   array['MBR.SIGN_PREPARED'], array[]::text[], false, false, 'ALL_COMPONENTS', false, 'US 211.186(a); EU Ch.4 4.3; DI-35'),
  ('CHECKED', 'MASTER_RECORD', 'VERIFIER', 'Independently checked', 'I independently checked this master document for accuracy and completeness.',
   array['MBR.CHECK'], array['PREPARED'], true, false, 'ALL_COMPONENTS', false, 'US 211.186(a); EU Ch.4 4.3; INV-04; DI-35'),
  ('APPROVED', 'MASTER_RECORD', 'APPROVER', 'Quality-unit approved', 'Quality-unit approval: I approve this document for use.',
   array['MBR.APPROVE'], array['PREPARED', 'CHECKED'], true, false, 'ALL_COMPONENTS', false, 'US 211.186(a) with quality-unit approval; EU Ch.4 4.3; INV-04; DI-35'),
  ('REGULATORY_CONFIRMED', 'MASTER_RECORD', 'APPROVER', 'Registration confirmed', 'I confirm the registration references and registered details for each market.',
   array['MBR.REGULATORY_CONFIRM'], array[]::text[], false, false, 'ALL_COMPONENTS', false, 'Outline 7.1 role K4'),
  ('SPECIMEN_APPROVED', 'MASTER_RECORD', 'APPROVER', 'Labelling specimen approved', 'I approve this labelling or printed packaging specimen.',
   array['MBR.APPROVE'], array['PREPARED'], true, false, 'ALL_COMPONENTS', false, 'EU Ch.4 packaging instructions and records; DI-35'),
  ('MBR_MARKET_AUTHORISED', 'MASTER_RECORD', 'APPROVER', 'Authorised for a market', 'I authorise this approved master-record version for the named market and scope.',
   array['MBR.APPROVE'], array[]::text[], false, false, 'ALL_COMPONENTS', false, 'ADR 0014 per-market effectivity'),
  -- Batch record
  ('ISSUED', 'BATCH_RECORD', 'APPROVER', 'Issued', 'I issued this batch record and checked that it accurately reproduces the approved master record.',
   array['BATCH.ISSUE'], array[]::text[], false, false, 'ALL_COMPONENTS', false, 'US 211.188(a); DI-35'),
  ('PRODUCTION_APPROVED', 'BATCH_RECORD', 'APPROVER', 'Production approved', 'As the person responsible for production, I approve this completed processing record.',
   array['RECORD.PRODUCTION_APPROVE'], array[]::text[], false, false, 'ALL_COMPONENTS', false, 'EU Ch.4 4.20(i); outline 7.2 S8; DI-35'),
  ('PACKAGING_RECORD_APPROVED', 'BATCH_RECORD', 'APPROVER', 'Packaging record approved', 'As the person responsible for packaging, I approve this completed packaging record.',
   array['RECORD.PRODUCTION_APPROVE'], array[]::text[], false, false, 'ALL_COMPONENTS', false, 'EU Ch.4 4.21(i); DI-35'),
  -- Execution
  ('PERFORMED', 'EXECUTION', 'PERFORMER', 'Performed', 'I performed this step and recorded its data.',
   array['STEP.SIGN_PERFORMED'], array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'US 211.188(b)(11); EU Ch.4 4.20(c), 4.21(c); DI-35'),
  ('SUPERVISED', 'EXECUTION', 'SUPERVISOR', 'Directly supervised', 'I directly supervised this step.',
   array['STEP.SUPERVISE'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.188(b)(11); DI-35'),
  ('IPC_PERFORMED', 'EXECUTION', 'PERFORMER', 'In-process control performed', 'I performed this in-process control and recorded its results.',
   array['STEP.SIGN_PERFORMED'], array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'EU Ch.4 4.20(f); US 211.194(a)(7); DI-35'),
  ('CORRECTED', 'EXECUTION', 'PERFORMER', 'Corrected', 'I corrected this entry; the original value and my reason are kept.',
   array['STEP.EXECUTE', 'DISPENSE.EXECUTE', 'QC.RESULT_RECORD', 'LOGBOOK.ENTRY', 'MATERIAL.HANDLE', 'LABELLING.ISSUE', 'MBR.AUTHOR', 'MASTERDATA.CHANGE'],
   array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'EU Ch.4 4.9; DI-24; outline 5.2.3 (a); DI-35'),
  ('LINE_CLEARANCE_PERFORMED', 'EXECUTION', 'PERFORMER', 'Line clearance performed', 'I performed this line clearance.',
   array['STEP.SIGN_PERFORMED'], array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'Outline 7.2 involvement set; S23'),
  ('SAMPLE_TAKEN', 'EXECUTION', 'PERFORMER', 'Sample taken', 'I took this sample as recorded.',
   array['STEP.SIGN_PERFORMED', 'QC.RESULT_RECORD'], array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'Outline 7.2 involvement set'),
  -- Second-person verification and witnessing (INV-03)
  ('VERIFIED', 'VERIFICATION', 'VERIFIER', 'Verified', 'I verified the recorded evidence of this step, performed by someone else.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.188(b)(11); EU Ch.4 4.20(c), 4.21(c); outline 5.5 VERIFIED; DI-35'),
  ('WITNESSED', 'VERIFICATION', 'WITNESS', 'Witnessed', 'I watched this act as it was performed.',
   array['STEP.WITNESS'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'Outline 5.5 WITNESSED (L-03); DI-35'),
  ('CONTAINER_CHECKED', 'VERIFICATION', 'VERIFIER', 'Dispensed container checked', 'As second person, I checked each dispensed container: released material, correct quantity, correct identification.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.101(c); DI-35'),
  ('CHARGE_IN_VERIFIED', 'VERIFICATION', 'VERIFIER', 'Charge-in verified', 'As second person, I verified that this component was added to the batch.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.101(d); DI-35'),
  ('YIELD_VERIFIED', 'VERIFICATION', 'VERIFIER', 'Yield verified', 'As second person, I independently verified this yield calculation.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.103; outline 7.2 S26; DI-35'),
  ('IPC_VERIFIED', 'VERIFICATION', 'VERIFIER', 'In-process control verified', 'As second person, I reviewed this in-process control record for accuracy, completeness and compliance.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.194(a)(8); DI-35'),
  ('RE_VERIFIED_AFTER_CORRECTION', 'VERIFICATION', 'VERIFIER', 'Re-verified after correction', 'As an uninvolved person, I verified this entry again after its correction.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'Outline 5.5 (L-07), 5.2.3'),
  ('LINE_CLEARANCE_VERIFIED', 'VERIFICATION', 'VERIFIER', 'Line clearance verified', 'As second person, I verified this line clearance.',
   array['STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'Outline 7.2 S23'),
  ('TRUE_COPY_VERIFIED', 'RECORDS', 'VERIFIER', 'True copy verified', 'I verified that this copy is complete and accurate, with its meaning and metadata preserved.',
   array['RECORD.QA_REVIEW'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'DI-41; DI-35'),
  -- Supervision and exceptions
  ('DEVIATION_AUTHORISED', 'EXCEPTION', 'AUTHORISER', 'Deviation authorised', 'I authorise this deviation from the approved instructions, with the justification recorded.',
   array['DEVIATION.APPROVE_INLINE', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'EU Ch.4 4.20(h), 4.21(g); US 211.100(b); outline 7.2 S7; DI-35'),
  ('EXCEPTION_DISPOSITIONED', 'EXCEPTION', 'AUTHORISER', 'Exception dispositioned', 'I dispositioned this exception.',
   array['RECORD.QA_REVIEW', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.4; INV-41'),
  ('HOLD_POINT_RELEASED', 'EXCEPTION', 'AUTHORISER', 'Hold point released', 'Quality-unit release of this hold point.',
   array['QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 7.2 involvement set'),
  ('VOID_AUTHORISED', 'EXCEPTION', 'SUPERVISOR', 'Void authorised', 'I authorise this void.',
   array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.3 (b); DI-35'),
  ('REPRINT_AUTHORISED', 'EXCEPTION', 'SUPERVISOR', 'Reprint authorised', 'I authorise this reprint.',
   array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'DI-35'),
  ('LATE_ENTRY_APPROVED', 'EXCEPTION', 'SUPERVISOR', 'Late entry approved', 'As supervisor, I approve this late entry and its reason.',
   array['STEP.SUPERVISE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 5.6 late-entry co-signature'),
  ('SKIP_APPROVED', 'EXCEPTION', 'SUPERVISOR', 'Skip approved', 'I approve skipping this phase.',
   array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.3'),
  ('NOT_APPLICABLE_APPROVED', 'EXCEPTION', 'SUPERVISOR', 'Not applicable approved', 'I approve marking this conditional item not applicable.',
   array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.3; PR-16'),
  ('HANDOVER_APPROVED', 'EXCEPTION', 'SUPERVISOR', 'Hand-over approved', 'I approve this hand-over of the step to another performer.',
   array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.3 (L-07)'),
  -- Logbooks
  ('LOGBOOK_PERFORMED', 'LOGBOOK', 'PERFORMER', 'Logbook entry performed', 'I performed the operation recorded in this logbook entry.',
   array['LOGBOOK.SIGN'], array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'US 211.182; EU Ch.4 4.31; DI-35'),
  ('LOGBOOK_DOUBLE_CHECKED', 'LOGBOOK', 'VERIFIER', 'Logbook entry double-checked', 'As second person, I double-checked the operation recorded in this logbook entry.',
   array['LOGBOOK.SIGN', 'STEP.VERIFY'], array[]::text[], true, false, 'SESSION_RELAXABLE', false, 'US 211.182; DI-35'),
  -- Laboratory
  ('QC_TEST_PERFORMED', 'LABORATORY', 'PERFORMER', 'Test performed', 'I performed this laboratory test and recorded its results.',
   array['QC.RESULT_RECORD'], array[]::text[], false, false, 'SESSION_RELAXABLE', false, 'US 211.194(a)(7)'),
  ('QC_RECORD_REVIEWED', 'LABORATORY', 'VERIFIER', 'Laboratory record reviewed', 'As second person, I reviewed this laboratory record for accuracy, completeness and compliance.',
   array['QC.RESULT_APPROVE'], array['QC_TEST_PERFORMED'], true, false, 'ALL_COMPONENTS', false, 'US 211.194(a)(8); outline 7.2 S21'),
  ('QC_RESULT_APPROVED', 'LABORATORY', 'APPROVER', 'QC result approved', 'I approve these QC results for use in release.',
   array['QC.RESULT_APPROVE'], array['QC_TEST_PERFORMED'], true, false, 'ALL_COMPONENTS', false, 'Outline 7.1 role K15; S21'),
  -- Review
  ('AUDIT_TRAIL_REVIEWED', 'REVIEW', 'REVIEWER', 'Audit trail reviewed', 'I reviewed the audit trail in scope of this record.',
   array['RECORD.AUDIT_TRAIL_REVIEW'], array[]::text[], true, true, 'ALL_COMPONENTS', false, 'DI-25; outline 5.4 review, 7.2 S10; INV-35; DI-35'),
  ('DELTA_AUDIT_TRAIL_REVIEWED', 'REVIEW', 'REVIEWER', 'Delta audit-trail review', 'I reviewed the audit-trail entries recorded after the previous review.',
   array['RECORD.AUDIT_TRAIL_REVIEW'], array[]::text[], true, true, 'ALL_COMPONENTS', false, 'INV-48; outline 5.4'),
  ('QA_REVIEWED', 'REVIEW', 'REVIEWER', 'Quality-unit review', 'Quality-unit review: I reviewed this record and its exceptions.',
   array['RECORD.QA_REVIEW'], array['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED'], true, false, 'ALL_COMPONENTS', false, 'US 211.192; outline 7.2 S8, S9; DI-35'),
  -- Release and dispositions
  ('MANUFACTURER_RELEASE', 'RELEASE', 'RELEASE', 'Manufacturer release decision', 'As the authorised person or named delegate, I decide the manufacturer release of this lot.',
   array['RELEASE.MANUFACTURER'], array['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED'], true, true, 'ALL_COMPONENTS', true,
   'Revised Schedule M; ADR 0013; outline 5.2.6, 7.1 delegation, 7.2 S10, S11; INV-35; DI-35'),
  ('US_DISPOSITION', 'RELEASE', 'RELEASE', 'US market disposition', 'Quality-unit disposition of this lot for the US market.',
   array['RELEASE.US_DISPOSITION'], array['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED'], true, true, 'ALL_COMPONENTS', false,
   'US 211.22; ADR 0013; outline 7.2 S10; INV-35; DI-35'),
  ('QP_CERTIFIED', 'RELEASE', 'RELEASE', 'QP certification', 'As qualified person, I certify this batch (only when in-system QP certification is used).',
   array['RELEASE.EU_QP_CERTIFY'], array['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED'], true, true, 'ALL_COMPONENTS', false,
   'EU Annex 16; ADR 0013; DI-35 (if used)'),
  ('QP_CERTIFICATION_RECORDED', 'RELEASE', 'RELEASE', 'QP certification reference recorded', 'I recorded the reference of the qualified-person certification made outside this system.',
   array['RECORD.QA_REVIEW'], array[]::text[], true, true, 'ALL_COMPONENTS', false, 'ADR 0013; DI-35'),
  -- Records administration (kernel records module)
  ('RECORD_TYPE_APPROVED', 'RECORDS', 'APPROVER', 'Record type approved', 'I approve this record-type definition.',
   array['MBR.APPROVE', 'RECORD.QA_REVIEW'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'DI-01 record-type register'),
  ('DI_INVESTIGATION_CLOSED', 'RECORDS', 'APPROVER', 'Data-integrity investigation closed', 'I approve the conclusion and remediation of this data-integrity investigation.',
   array['RECORD.QA_REVIEW'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'DI-12 investigations'),
  ('RECORD_DISPOSAL_APPROVED', 'RECORDS', 'APPROVER', 'Record disposal approved', 'I approve the disposal of this record after its retention period.',
   array['RECORD.QA_REVIEW'], array[]::text[], true, false, 'ALL_COMPONENTS', false, 'DI-47; INV-22')
) as s (code, category, role_class, title, meaning_text, permissions, independent_of, excludes_performers, excludes_involved, reauth, delegable, sources);

-- The newest version of every type.
create view esig.meaning_catalogue as
  select distinct on (m.code) m.* from esig.meaning_type m order by m.code, m.version desc;

-- The newest version of a type, refused when unknown or retired.
create function esig.current_meaning(p_code text) returns esig.meaning_type
language plpgsql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v esig.meaning_type%rowtype;
begin
  select * into v from esig.meaning_type where code = p_code order by version desc limit 1;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-026 %s is not a signature type of the catalogue; only catalogue types can be signed (no plain acknowledgement)', coalesce(p_code, '(null)'));
  end if;
  if v.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-026 signature type %s is retired', p_code);
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Predicate-rule inventory (DI-35 catalog test): every point where a rule asks for a signature,
-- initials, a check or an approval, mapped to the catalogue type that implements it.
-- ---------------------------------------------------------------------------------------------

create table esig.predicate_signature_point (
  code          text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  description   text not null,
  jurisdiction  text not null check (jurisdiction in ('US', 'EU', 'IN', 'US+EU', 'ALL')),
  sources       text not null,
  meaning_code  text not null
);
select esig.protect_log('esig.predicate_signature_point');

insert into esig.predicate_signature_point (code, description, jurisdiction, sources, meaning_code) values
  ('MPCR_PREPARED', 'Master production and control record prepared, dated and signed', 'US+EU', 'US 211.186(a); EU Ch.4 4.3', 'PREPARED'),
  ('MPCR_INDEPENDENTLY_CHECKED', 'Master record independently checked by a second person', 'US+EU', 'US 211.186(a); EU Ch.4 4.3', 'CHECKED'),
  ('MPCR_QU_APPROVED', 'Master record approved by the quality unit', 'US+EU', 'US 211.186(a); EU Ch.4 4.3', 'APPROVED'),
  ('BATCH_RECORD_ISSUED', 'Batch record issued as a checked, accurate reproduction of the master record', 'US', 'US 211.188(a)', 'ISSUED'),
  ('STEP_PERFORMED', 'Person performing each significant step identified', 'US+EU', 'US 211.188(b)(11); EU Ch.4 4.20(c), 4.21(c)', 'PERFORMED'),
  ('STEP_CHECKED', 'Person checking each significant step identified', 'US+EU', 'US 211.188(b)(11); EU Ch.4 4.20(c), 4.21(c)', 'VERIFIED'),
  ('STEP_DIRECTLY_SUPERVISED', 'Person directly supervising each significant step identified', 'US', 'US 211.188(b)(11)', 'SUPERVISED'),
  ('ACT_WITNESSED', 'Critical act without objective evidence witnessed as it happens', 'ALL', 'Outline 5.5 (L-03)', 'WITNESSED'),
  ('DISPENSED_CONTAINER_CHECKED', 'Each dispensed component container examined by a second person', 'US', 'US 211.101(c)', 'CONTAINER_CHECKED'),
  ('CHARGE_IN_VERIFIED', 'Each component added to the batch verified by a second person', 'US', 'US 211.101(d)', 'CHARGE_IN_VERIFIED'),
  ('YIELD_VERIFIED', 'Yield calculation independently verified by a second person', 'US', 'US 211.103', 'YIELD_VERIFIED'),
  ('IPC_PERFORMED', 'In-process controls recorded with the initials of the person carrying them out', 'US+EU', 'EU Ch.4 4.20(f); US 211.194(a)(7)', 'IPC_PERFORMED'),
  ('IPC_VERIFIED', 'In-process control records reviewed by a second person', 'US', 'US 211.194(a)(8)', 'IPC_VERIFIED'),
  ('LAB_TEST_PERFORMED', 'Laboratory test performer identified', 'US', 'US 211.194(a)(7)', 'QC_TEST_PERFORMED'),
  ('LAB_RECORD_REVIEWED', 'Laboratory record reviewed by a second person for accuracy, completeness and compliance', 'US', 'US 211.194(a)(8)', 'QC_RECORD_REVIEWED'),
  ('DEVIATION_AUTHORISED', 'Signed authorisation of any deviation from the instructions', 'US+EU', 'EU Ch.4 4.20(h), 4.21(g); US 211.100(b)', 'DEVIATION_AUTHORISED'),
  ('ENTRY_CORRECTED', 'Alteration of an entry signed and dated with the reason recorded', 'EU', 'EU Ch.4 4.9', 'CORRECTED'),
  ('LABELLING_SPECIMEN_APPROVED', 'Labelling and printed packaging specimen approved', 'ALL', 'DI-35 behaviour; EU Ch.4 packaging instructions', 'SPECIMEN_APPROVED'),
  ('LOGBOOK_ENTRY_PERFORMED', 'Equipment cleaning, maintenance and use log entry by the person performing it', 'US+EU', 'US 211.182; EU Ch.4 4.31', 'LOGBOOK_PERFORMED'),
  ('LOGBOOK_ENTRY_DOUBLE_CHECKED', 'Equipment cleaning and maintenance log double-checked by a second person', 'US', 'US 211.182', 'LOGBOOK_DOUBLE_CHECKED'),
  ('PROCESSING_RECORD_APPROVED', 'Completed processing record approved by the person responsible for processing', 'EU', 'EU Ch.4 4.20(i)', 'PRODUCTION_APPROVED'),
  ('PACKAGING_RECORD_APPROVED', 'Completed packaging record approved by the person responsible for packaging', 'EU', 'EU Ch.4 4.21(i)', 'PACKAGING_RECORD_APPROVED'),
  ('AUDIT_TRAIL_REVIEWED', 'Audit trail of the batch reviewed before release', 'ALL', 'DI-25; EU Annex 11 9', 'AUDIT_TRAIL_REVIEWED'),
  ('QU_REVIEW', 'Quality-unit review of the production and control records', 'US', 'US 211.192', 'QA_REVIEWED'),
  ('MANUFACTURER_RELEASE', 'Release of the lot by the manufacturer''s authorised person', 'IN', 'Revised Schedule M; ADR 0013', 'MANUFACTURER_RELEASE'),
  ('QU_DISPOSITION_US', 'Quality-unit approval or rejection of the lot for the US market', 'US', 'US 211.22; ADR 0013', 'US_DISPOSITION'),
  ('QP_CERTIFICATION', 'Qualified-person certification (if done in the system)', 'EU', 'EU Annex 16; ADR 0013', 'QP_CERTIFIED'),
  ('QP_CERTIFICATION_REFERENCE', 'Reference to a qualified-person certification made at the EU site', 'EU', 'ADR 0013', 'QP_CERTIFICATION_RECORDED'),
  ('TRUE_COPY_VERIFIED', 'Copy verified as a true copy (complete, accurate, meaning preserved)', 'ALL', 'DI-41', 'TRUE_COPY_VERIFIED'),
  ('VOID_AUTHORISED', 'Void of an attempt or document authorised', 'ALL', 'DI-35 behaviour', 'VOID_AUTHORISED'),
  ('REPRINT_AUTHORISED', 'Reprint of a controlled document or label authorised', 'ALL', 'DI-35 behaviour', 'REPRINT_AUTHORISED');

-- ---------------------------------------------------------------------------------------------
-- Quality-unit configuration (company signature policy and e-signature policy values)
-- ---------------------------------------------------------------------------------------------

-- The quality unit (permission MBR.APPROVE: QA approval of master documents, which include the
-- company signature policy) changes a policy value, with a reason and a change-control reference.
create function esig.set_policy(p_key text, p_value text, p_reason text, p_change_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  v_k     esig.policy_key%rowtype;
  v_n     bigint;
begin
  perform iam.assert_not_administrator();
  select * into v_k from esig.policy_key where key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-002 unknown e-signature policy key %s', p_key);
  end if;
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_change_ref), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-005 a policy change needs a reason and a change-control reference';
  end if;
  if v_k.value_type = 'INTEGER' then
    if p_value !~ '^-?[0-9]{1,18}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s takes a whole number', p_key);
    end if;
    v_n := p_value::bigint;
    if (v_k.min_value is not null and v_n < v_k.min_value) or (v_k.max_value is not null and v_n > v_k.max_value) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-005 %s must lie between %s and %s', p_key, v_k.min_value, v_k.max_value);
    end if;
  elsif v_k.value_type = 'BOOLEAN' then
    if p_value not in ('true', 'false') then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s takes true or false', p_key);
    end if;
  elsif v_k.allowed_values is not null and not p_value = any (v_k.allowed_values) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s takes one of %s', p_key, v_k.allowed_values);
  end if;
  insert into esig.policy_value (key, value, set_by_person, set_by_account, reason, change_ref)
  values (p_key, p_value, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_reason, p_change_ref);
end
$$;

-- A customer signature point: a new type, version 1. Every customer type is a full electronic
-- signature (reauth ALL_COMPONENTS or SESSION_RELAXABLE; a type that could be completed with a
-- plain acknowledgement cannot be expressed).
create function esig.add_meaning_type(p_code text, p_definition jsonb, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  d jsonb := coalesce(p_definition, '{}'::jsonb);
begin
  perform iam.assert_not_administrator();
  insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                                 independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources,
                                 defined_by_person, defined_by_account, reason)
  values (p_code, 1, 'CUSTOMER', false, 'ACTIVE', d ->> 'category', d ->> 'role_class', d ->> 'title', d ->> 'meaning_text',
          coalesce(array(select jsonb_array_elements_text(d -> 'permissions')), '{}'),
          coalesce(array(select jsonb_array_elements_text(d -> 'independent_of')), '{}'),
          coalesce((d ->> 'excludes_performers')::boolean, true), coalesce((d ->> 'excludes_involved')::boolean, false),
          coalesce((d ->> 'witness')::boolean, false), coalesce(d ->> 'reauth', 'ALL_COMPONENTS'),
          coalesce((d ->> 'delegable')::boolean, false), coalesce(d ->> 'sources', 'Customer signature point'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_reason);
end
$$;

-- A new version of a type (company signature policy: who may sign, tightened rules). Keys of
-- p_changes: permissions, independent_of, reauth, excludes_performers, excludes_involved, witness,
-- delegable, and for customer types title, meaning_text, category, role_class, sources.
create function esig.configure_meaning_type(p_code text, p_changes jsonb, p_reason text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  v       esig.meaning_type%rowtype;
  c       jsonb := coalesce(p_changes, '{}'::jsonb);
  k       text;
begin
  perform iam.assert_not_administrator();
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-005 a change to the signature catalogue needs a reason';
  end if;
  for k in select jsonb_object_keys(c) loop
    if k not in ('permissions', 'independent_of', 'reauth', 'excludes_performers', 'excludes_involved', 'witness', 'delegable', 'title',
                 'meaning_text', 'category', 'role_class', 'sources', 'status') then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s cannot be changed', k);
    end if;
  end loop;
  select * into v from esig.meaning_type where code = p_code order by version desc limit 1;
  if not found then
    perform esig.current_meaning(p_code);
  end if;
  insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                                 independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources,
                                 defined_by_person, defined_by_account, reason)
  values (v.code, v.version + 1, v.origin, v.is_minimum, coalesce(c ->> 'status', v.status), coalesce(c ->> 'category', v.category),
          coalesce(c ->> 'role_class', v.role_class), coalesce(c ->> 'title', v.title), coalesce(c ->> 'meaning_text', v.meaning_text),
          case when c ? 'permissions' then array(select jsonb_array_elements_text(c -> 'permissions')) else v.permissions end,
          case when c ? 'independent_of' then array(select jsonb_array_elements_text(c -> 'independent_of')) else v.independent_of end,
          coalesce((c ->> 'excludes_performers')::boolean, v.excludes_performers), coalesce((c ->> 'excludes_involved')::boolean, v.excludes_involved),
          coalesce((c ->> 'witness')::boolean, v.witness), coalesce(c ->> 'reauth', v.reauth), coalesce((c ->> 'delegable')::boolean, v.delegable),
          coalesce(c ->> 'sources', v.sources), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_reason);
  return v.version + 1;
end
$$;

-- Retire a customer type (a minimum type can never be retired: EBMR-ESIG-022).
create function esig.retire_meaning_type(p_code text, p_reason text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
begin
  return esig.configure_meaning_type(p_code, jsonb_build_object('status', 'RETIRED'), p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit registration (after the seed: the vendor rows are covered by this migration's checksum)
-- and privileges
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('esig.meaning_type', 'esig_meaning', 'code', true);

grant select on esig.meaning_type, esig.meaning_catalogue, esig.predicate_signature_point to ebmr_app;
grant execute on function esig.current_meaning(text), esig.set_policy(text, text, text, text), esig.add_meaning_type(text, jsonb, text),
                          esig.configure_meaning_type(text, jsonb, text), esig.retire_meaning_type(text, text) to ebmr_app;

reset role;
