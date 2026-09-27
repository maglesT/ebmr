-- Records module (B4), part 3: retention schedules, retention dependencies and holds (DI-47, INV-22).
--
-- Design: the database computes retention itself (records.evaluate_retention mirrors the pure TS
-- function in src/records/retention.ts, and a property test proves they agree). The database copy is
-- authoritative because INV-22 must hold even against a faulty or hostile application: purge
-- (part 5) recomputes the retain-until from the stored inputs and rule rows and never trusts a date
-- supplied by the caller. Every evaluation is stored with its inputs version and rule-set version.
--
-- Dates are site-local calendar dates (the site zone is stored on the schedule). retain_until is the
-- last day the record must be kept: disposal is allowed only when the site-local date is later.
--
-- Rule rows (records.retention_rule) are the interim parameters from src/records/retention-rules.ts;
-- the market-profile engine (B3) will serve them as rule keys later. They are seeded here, before the
-- table is registered for audit, because a migration has no actor; the migration file itself is the
-- controlled record of the seed (its checksum is enforced by the migration runner).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Rule set
-- ---------------------------------------------------------------------------------------------

create table records.retention_rule_set (
  version       text primary key,
  note          text not null,
  published_at  timestamptz not null default clock_timestamp()
);

create table records.retention_rule (
  rule_set_version   text not null references records.retention_rule_set (version),
  rule_id            text not null check (rule_id ~ '^[A-Z][A-Z0-9_]*$'),
  proposed_rule_key  text not null,
  retention_keys     text[] not null,
  market             text check (market in ('IN', 'US', 'EU')),
  predicate          jsonb not null default '{}'::jsonb check (jsonb_typeof(predicate) = 'object'),
  anchor             text not null check (anchor in ('EXPIRY', 'MANUFACTURE', 'DISTRIBUTION', 'EU_CERTIFICATION', 'DISPOSITION',
                                                     'ABORT_CANCEL', 'TRANSACTION', 'MA_END', 'OPEN')),
  period_years       integer not null check (period_years >= 0),
  period_months      integer not null check (period_months between 0 and 11),
  open_reason        text,
  source             text not null,
  verification       text not null check (verification in ('CHECKED', 'S', 'U', 'P~', 'DESIGN')),
  primary key (rule_set_version, rule_id),
  check ((anchor = 'OPEN') = (open_reason is not null))
);

insert into records.retention_rule_set (version, note)
values ('RET-2026.1', 'Interim retention parameters (src/records/retention-rules.ts); to be served by market-profile rule keys (B3).');

insert into records.retention_rule (rule_set_version, rule_id, proposed_rule_key, retention_keys, market, predicate, anchor, period_years, period_months, open_reason, source, verification) values
('RET-2026.1', 'IN_SCHEDULE_M_EXPIRY', 'kernel.retention.batch.afterExpiry', '{BATCH_RECORD}', 'IN', '{"expiryLabelled": true}', 'EXPIRY', 1, 0, null,
 'Revised Schedule M Part I 17.2: batch records kept at least one year after the expiry of the finished product', 'P~'),
('RET-2026.1', 'IN_FORM25_MANUFACTURE', 'kernel.retention.batch.afterManufacture', '{BATCH_RECORD}', 'IN', '{"licenceForm": "FORM_25"}', 'MANUFACTURE', 5, 0, null,
 'Drugs Rules Rule 74 conditions of a Form 25 licence with Schedule U: records kept five years from manufacture (India G-1)', 'U'),
('RET-2026.1', 'IN_FORM28_EXPIRY', 'kernel.retention.testRecords.afterExpiry', '{BATCH_RECORD}', 'IN', '{"licenceForm": "FORM_28", "expiryLabelled": true}', 'EXPIRY', 2, 0, null,
 'Drugs Rules Rule 78 conditions of a Form 28 licence: test records kept two years after expiry where expiry is labelled (India G-1)', 'U'),
('RET-2026.1', 'IN_FORM28_MANUFACTURE', 'kernel.retention.testRecords.afterManufacture', '{BATCH_RECORD}', 'IN', '{"licenceForm": "FORM_28", "expiryLabelled": false}', 'MANUFACTURE', 5, 0, null,
 'Drugs Rules Rule 78 conditions of a Form 28 licence: five years from manufacture where no expiry is labelled (India G-1)', 'U'),
('RET-2026.1', 'US_EXPIRY', 'kernel.retention.batch.afterExpiry', '{BATCH_RECORD}', 'US', '{"otcExpiryExempt": false}', 'EXPIRY', 1, 0, null,
 '21 CFR 211.180(a): batch records kept at least one year after the batch expiration date', 'CHECKED'),
('RET-2026.1', 'US_OTC_DISTRIBUTION', 'kernel.retention.batch.afterDistribution', '{BATCH_RECORD}', 'US', '{"otcExpiryExempt": true}', 'DISTRIBUTION', 3, 0, null,
 '21 CFR 211.180(a): OTC products exempt from expiration dating (211.137), three years after distribution of the batch', 'CHECKED'),
('RET-2026.1', 'EU_EXPIRY', 'kernel.retention.batch.afterExpiry', '{BATCH_RECORD}', 'EU', '{}', 'EXPIRY', 1, 0, null,
 'EU GMP Chapter 4, 4.11: batch documentation kept one year after batch expiry', 'CHECKED'),
('RET-2026.1', 'EU_QP_CERTIFICATION', 'kernel.retention.batch.afterCertification', '{BATCH_RECORD}', 'EU', '{"euCertification": "CERTIFIED"}', 'EU_CERTIFICATION', 5, 0, null,
 'EU GMP Chapter 4, 4.11: or at least five years after QP certification, whichever is longer', 'CHECKED'),
('RET-2026.1', 'EU_CERTIFICATION_PENDING', 'kernel.retention.batch.openUntilCertified', '{BATCH_RECORD}', 'EU', '{"euCertification": "PENDING", "aborted": false}', 'OPEN', 0, 0, 'PENDING_EU_CERTIFICATION',
 'Owner decision record 0001 (default adopted): retention stays open until the EU certification date is received; DI-47', 'DESIGN'),
('RET-2026.1', 'EU_NEVER_CERTIFIED_DISPOSITION', 'kernel.retention.batch.afterDispositionUncertified', '{BATCH_RECORD}', 'EU', '{"euCertification": "NEVER_CERTIFIED"}', 'DISPOSITION', 5, 0, null,
 'Outline 3.3.6 and PR F-2: EU batch never certified, disposition plus five years (design default, QA to confirm)', 'DESIGN'),
('RET-2026.1', 'ABORTED_NOMINAL_EXPIRY', 'kernel.retention.abortedBatch.afterNominalExpiry', '{BATCH_RECORD}', null, '{"aborted": true}', 'EXPIRY', 1, 0, null,
 'Outline 3.3.6: aborted or cancelled batch, nominal expiry it would have had plus one year (design default, QA to confirm)', 'DESIGN'),
('RET-2026.1', 'ABORTED_CANCEL_DATE', 'kernel.retention.abortedBatch.afterAbort', '{BATCH_RECORD}', null, '{"aborted": true}', 'ABORT_CANCEL', 5, 0, null,
 'Outline 3.3.6: aborted or cancelled batch, abort or cancel date plus five years (design default, QA to confirm)', 'DESIGN'),
('RET-2026.1', 'US_DSCSA_TRANSACTION', 'kernel.retention.dscsa.afterTransaction', '{DSCSA_RECORD}', 'US', '{}', 'TRANSACTION', 6, 0, null,
 'DSCSA (FD&C Act 582): serial and transaction records kept at least six years after the transaction', 'S'),
('RET-2026.1', 'EU_VALIDATION_MA_IN_FORCE', 'kernel.retention.validationRawData.whileAuthorised', '{VALIDATION_RAW_DATA}', 'EU', '{"maInForce": true}', 'OPEN', 0, 0, 'MARKETING_AUTHORISATION_IN_FORCE',
 'EU GMP Chapter 4, 4.12: documentation supporting the marketing authorisation kept while the authorisation is in force', 'CHECKED'),
('RET-2026.1', 'EU_VALIDATION_MA_END', 'kernel.retention.validationRawData.afterAuthorisationEnds', '{VALIDATION_RAW_DATA}', 'EU', '{"maInForce": false}', 'MA_END', 0, 0, null,
 'EU GMP Chapter 4, 4.12: until the authorisation ends; batches released on it extend this through retention dependencies', 'CHECKED');

select kernel.register_audited_table('records.retention_rule_set', 'retention_rule_set', 'version', true);
select kernel.register_audited_table('records.retention_rule', 'retention_rule_set', 'rule_set_version', true);

create function records.current_retention_rule_set() returns text
language sql stable security definer set search_path = pg_catalog, records, kernel as $$
  select version from records.retention_rule_set order by published_at desc, version desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Pure evaluation (mirror of evaluateOwnRetention in src/records/retention.ts)
-- ---------------------------------------------------------------------------------------------

-- p_inputs: normalised inputs plus "retentionKey". Returns
-- {ruleSetVersion, status DATED|OPEN|NONE, retainUntil, latestDated, governingRules[], openReasons[], evaluated[]}.
create function records.evaluate_retention(p_inputs jsonb, p_rule_set_version text default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_version text := coalesce(p_rule_set_version, records.current_retention_rule_set());
  v_markets text[] := array(select jsonb_array_elements_text(coalesce(p_inputs -> 'markets', '[]'::jsonb)));
  v_facts jsonb;
  r records.retention_rule%rowtype;
  v_anchor_key text;
  v_anchor date;
  v_date date;
  v_evaluated jsonb := '[]'::jsonb;
  v_any boolean := false;
  v_max date;
  v_open text[] := '{}';
  v_governing text[] := '{}';
begin
  if not exists (select 1 from records.retention_rule_set where version = v_version) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-020 retention rule set %s does not exist', v_version);
  end if;
  v_facts := jsonb_build_object(
    'licenceForm', coalesce(p_inputs -> 'licenceForm', 'null'::jsonb),
    'expiryLabelled', (p_inputs ->> 'expiryDate') is not null,
    'otcExpiryExempt', coalesce((p_inputs ->> 'otcExpiryExempt')::boolean, false),
    'euCertification', case when (p_inputs ->> 'euCertificationDate') is not null then 'CERTIFIED'
                            when coalesce((p_inputs ->> 'euNeverCertified')::boolean, false) then 'NEVER_CERTIFIED'
                            else 'PENDING' end,
    'aborted', (p_inputs ->> 'abortCancelDate') is not null,
    'maInForce', (p_inputs ->> 'maEndDate') is null);
  for r in
    select * from records.retention_rule rr
    where rr.rule_set_version = v_version
      and (p_inputs ->> 'retentionKey') = any(rr.retention_keys)
      and (rr.market is null or rr.market = any(v_markets))
      and not exists (select 1 from jsonb_each(rr.predicate) p where coalesce(v_facts -> p.key, 'null'::jsonb) is distinct from p.value)
    order by rr.rule_id collate "C"
  loop
    v_any := true;
    if r.anchor = 'OPEN' then
      v_evaluated := v_evaluated || jsonb_build_array(jsonb_build_object('ruleId', r.rule_id, 'status', 'OPEN', 'date', null, 'reason', r.open_reason));
      v_open := v_open || r.open_reason;
      continue;
    end if;
    v_anchor_key := case r.anchor when 'EXPIRY' then 'expiryDate' when 'MANUFACTURE' then 'manufactureDate'
                                  when 'DISTRIBUTION' then 'distributionDate' when 'EU_CERTIFICATION' then 'euCertificationDate'
                                  when 'DISPOSITION' then 'dispositionDate' when 'ABORT_CANCEL' then 'abortCancelDate'
                                  when 'TRANSACTION' then 'lastTransactionDate' when 'MA_END' then 'maEndDate' end;
    v_anchor := (p_inputs ->> v_anchor_key)::date;
    if v_anchor is null then
      v_evaluated := v_evaluated || jsonb_build_array(jsonb_build_object('ruleId', r.rule_id, 'status', 'OPEN', 'date', null,
                                                                          'reason', 'MISSING_INPUT:' || r.anchor));
      v_open := v_open || ('MISSING_INPUT:' || r.anchor);
      continue;
    end if;
    v_date := records.add_period(v_anchor, r.period_years, r.period_months);
    v_evaluated := v_evaluated || jsonb_build_array(jsonb_build_object('ruleId', r.rule_id, 'status', 'DATED',
                                                                        'date', to_char(v_date, 'YYYY-MM-DD'), 'reason', null));
    if v_max is null or v_date > v_max then
      v_max := v_date;
      v_governing := array[r.rule_id];
    elsif v_date = v_max then
      v_governing := v_governing || r.rule_id;
    end if;
  end loop;
  v_open := array(select y.x from (select distinct x from unnest(v_open) x) y order by y.x collate "C");
  return jsonb_build_object(
    'ruleSetVersion', v_version,
    'status', case when not v_any then 'NONE' when cardinality(v_open) > 0 then 'OPEN' else 'DATED' end,
    'retainUntil', case when v_any and cardinality(v_open) = 0 then to_char(v_max, 'YYYY-MM-DD') end,
    'latestDated', to_char(v_max, 'YYYY-MM-DD'),
    'governingRules', case when cardinality(v_open) > 0
                           then to_jsonb(array(select e ->> 'ruleId' from jsonb_array_elements(v_evaluated) e where e ->> 'status' = 'OPEN'))
                           else to_jsonb(v_governing) end,
    'openReasons', to_jsonb(v_open),
    'evaluated', v_evaluated);
end
$$;

-- Validates and normalises retention inputs: every key present, dates as YYYY-MM-DD, markets sorted.
create function records.normalize_retention_inputs(p jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, records as $$
declare
  k text;
  v_dates text[] := array['manufactureDate', 'expiryDate', 'distributionDate', 'euCertificationDate', 'dispositionDate',
                          'abortCancelDate', 'lastTransactionDate', 'maEndDate'];
  v_bools text[] := array['otcExpiryExempt', 'euNeverCertified'];
  v_out jsonb;
  v_markets text[];
  v_d date;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 retention inputs must be a JSON object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(v_dates) or k = any(v_bools) or k in ('markets', 'licenceForm')) then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-020 unknown retention input %s', k);
    end if;
  end loop;
  if jsonb_typeof(p -> 'markets') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 retention inputs need the market set';
  end if;
  v_markets := array(select y.m from (select distinct m from jsonb_array_elements_text(p -> 'markets') m) y order by y.m collate "C");
  if exists (select 1 from unnest(v_markets) m where m not in ('IN', 'US', 'EU')) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 markets must be IN, US or EU';
  end if;
  if not 'IN' = any(v_markets) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 India is in every market set (INV-28); IN is missing';
  end if;
  v_out := jsonb_build_object('markets', to_jsonb(v_markets));
  if coalesce(jsonb_typeof(p -> 'licenceForm'), 'null') = 'null' then
    v_out := v_out || jsonb_build_object('licenceForm', null);
  elsif p ->> 'licenceForm' in ('FORM_25', 'FORM_28') then
    v_out := v_out || jsonb_build_object('licenceForm', p ->> 'licenceForm');
  else
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 licenceForm must be FORM_25, FORM_28 or null';
  end if;
  foreach k in array v_bools loop
    if coalesce(jsonb_typeof(p -> k), 'null') = 'null' then
      v_out := v_out || jsonb_build_object(k, false);
    elsif jsonb_typeof(p -> k) = 'boolean' then
      v_out := v_out || jsonb_build_object(k, (p ->> k)::boolean);
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s must be true or false', k);
    end if;
  end loop;
  foreach k in array v_dates loop
    if coalesce(jsonb_typeof(p -> k), 'null') = 'null' then
      v_out := v_out || jsonb_build_object(k, null);
    elsif jsonb_typeof(p -> k) = 'string' and (p ->> k) ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_d := (p ->> k)::date;
      exception when others then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s is not a valid calendar date', k);
      end;
      if to_char(v_d, 'YYYY-MM-DD') <> p ->> k then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s is not a valid calendar date', k);
      end if;
      v_out := v_out || jsonb_build_object(k, p ->> k);
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s must be a date written YYYY-MM-DD', k);
    end if;
  end loop;
  if (v_out ->> 'euCertificationDate') is not null and (v_out ->> 'euNeverCertified')::boolean then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 a batch cannot be both certified and never certified for the EU';
  end if;
  if (v_out ->> 'expiryDate') is not null and (v_out ->> 'manufactureDate') is not null
     and (v_out ->> 'expiryDate')::date < (v_out ->> 'manufactureDate')::date then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 the expiry date lies before the manufacturing date';
  end if;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Schedules, inputs, evaluations, dependencies (all insert-only)
-- ---------------------------------------------------------------------------------------------

create table records.retention_schedule (
  id                   uuid primary key default gen_random_uuid(),
  record_key           text not null unique,
  aggregate_type       text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_id         text not null,
  record_type_code     text not null,
  record_type_version  integer not null,
  retention_key        text not null check (retention_key in ('BATCH_RECORD', 'SUPPORTING_RECORD', 'DSCSA_RECORD', 'VALIDATION_RAW_DATA')),
  site_zone            text not null,
  created_by_person    uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  foreign key (record_type_code, record_type_version) references records.record_type (code, version),
  check (record_key = aggregate_type || ':' || aggregate_id),
  -- Records of the retention machinery itself are never subject to purge.
  check (aggregate_type not in ('retention', 'retention_rule_set', 'record_hold', 'tombstone', 'true_copy'))
);

create table records.retention_input (
  id                 bigint generated always as identity primary key,
  schedule_id        uuid not null references records.retention_schedule (id),
  record_key         text not null,
  input_version      integer not null check (input_version >= 1),
  inputs             jsonb not null check (inputs -> 'markets' ? 'IN'),
  change_reason      text not null check (length(btrim(change_reason)) > 0),
  entered_by_person  uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (schedule_id, input_version)
);

create table records.retention_evaluation (
  id                      bigint generated always as identity primary key,
  schedule_id             uuid not null references records.retention_schedule (id),
  record_key              text not null,
  input_version           integer not null,
  rule_set_version        text not null references records.retention_rule_set (version),
  own                     jsonb not null,
  effective               jsonb not null,
  effective_status        text not null check (effective_status in ('DATED', 'OPEN')),
  effective_retain_until  date,
  cause                   text not null check (cause in ('CREATED', 'INPUT_CHANGED', 'DEPENDENCY_LINKED', 'DEPENDANT_CHANGED')),
  recorded_at             timestamptz not null default clock_timestamp(),
  check ((effective_status = 'DATED') = (effective_retain_until is not null))
);
create index retention_evaluation_latest on records.retention_evaluation (schedule_id, id desc);

-- A supporting record (component lot, APS run, logbook, MBR version, ...) and a record that depends on it.
create table records.retention_dependency (
  id                      uuid primary key default gen_random_uuid(),
  supporting_schedule_id  uuid not null references records.retention_schedule (id),
  dependant_schedule_id   uuid not null references records.retention_schedule (id),
  supporting_record_key   text not null,
  dependant_record_key    text not null,
  link_kind               text not null check (length(btrim(link_kind)) > 0),
  linked_by_person        uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  unique (supporting_schedule_id, dependant_schedule_id),
  check (supporting_schedule_id <> dependant_schedule_id)
);
create index retention_dependency_dependant on records.retention_dependency (dependant_schedule_id);

-- ---------------------------------------------------------------------------------------------
-- Holds (insert-only; a release is its own row)
-- ---------------------------------------------------------------------------------------------

create table records.retention_hold (
  id                uuid primary key default gen_random_uuid(),
  record_key        text not null,
  aggregate_type    text not null,
  aggregate_id      text not null,
  kind              text not null check (kind in ('LEGAL', 'DI_INVESTIGATION')),
  reason            text not null check (length(btrim(reason)) > 0),
  reference         text,
  investigation_id  uuid,
  placed_by_person  uuid not null,
  recorded_at       timestamptz not null default clock_timestamp(),
  check (record_key = aggregate_type || ':' || aggregate_id),
  check ((kind = 'DI_INVESTIGATION') = (investigation_id is not null))
);
create index retention_hold_record on records.retention_hold (record_key);
create unique index retention_hold_one_per_investigation on records.retention_hold (investigation_id, record_key) where investigation_id is not null;

create table records.retention_hold_release (
  hold_id             uuid primary key references records.retention_hold (id),
  record_key          text not null,
  reason              text not null check (length(btrim(reason)) > 0),
  released_by_person  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);

-- ---------------------------------------------------------------------------------------------
-- True-copy register, purge approvals and tombstones (insert-only; functions in part 5)
-- ---------------------------------------------------------------------------------------------

-- A true-copy bundle made from an audit chain (src/records/true-copy.ts): which chain head it covers
-- and the SHA-256 of its manifest, so an archived bundle can be matched to the record later.
create table records.true_copy (
  id                 uuid primary key default gen_random_uuid(),
  record_key         text not null,
  head_seq           bigint not null check (head_seq >= 1),
  head_hash          bytea not null,
  manifest_sha256    text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_format      text not null,
  purpose            text not null check (length(btrim(purpose)) > 0),
  created_by_person  uuid not null,
  recorded_at        timestamptz not null default clock_timestamp()
);
create index true_copy_record on records.true_copy (record_key);

-- QA approval to dispose of one record after its retention ended (DI-47: who approved).
create table records.purge_approval (
  id                     uuid primary key default gen_random_uuid(),
  schedule_id            uuid not null references records.retention_schedule (id),
  record_key             text not null,
  approved_by_person     uuid not null,
  approval_signature_id  uuid not null,
  reason                 text not null check (length(btrim(reason)) > 0),
  retain_until           date not null,
  true_copy_id           uuid references records.true_copy (id),
  recorded_at            timestamptz not null default clock_timestamp()
);
create index purge_approval_schedule on records.purge_approval (schedule_id, recorded_at desc);

-- What was purged, when, under which retention and approval, with the hashes that let the remaining
-- chains and anchors still verify (INV-22, ADR 0007).
create table records.tombstone (
  id                         uuid primary key default gen_random_uuid(),
  record_key                 text not null unique,
  aggregate_type             text not null,
  aggregate_id               text not null,
  schedule_id                uuid not null references records.retention_schedule (id),
  record_type_code           text not null,
  retention_key              text not null,
  rule_set_version           text not null,
  retain_until               date not null,
  effective_retention        jsonb not null,
  purged_on_site_date        date not null,
  site_zone                  text not null,
  approval_id                uuid not null references records.purge_approval (id),
  approved_by_person         uuid not null,
  approval_signature_id      uuid not null,
  true_copy_id               uuid references records.true_copy (id),
  true_copy_manifest_sha256  text,
  executed_by_person         uuid not null,
  executed_by_source         text not null,
  reason_code                text not null,
  reason_text                text,
  purged_tables              jsonb not null,
  chain_key                  text not null,
  chain_event_count          bigint not null check (chain_event_count >= 1),
  chain_head_hash            bytea not null,
  checkpoint_id              bigint,
  chain_event_hashes         bytea[] not null,
  recorded_at                timestamptz not null default clock_timestamp(),
  -- INV-22 again at the table level: nothing is purged on or before its retain-until.
  check (purged_on_site_date > retain_until),
  check (cardinality(chain_event_hashes) = chain_event_count),
  check (chain_event_hashes[chain_event_count] = chain_head_hash)
);

create view records.active_hold as
select h.* from records.retention_hold h
where not exists (select 1 from records.retention_hold_release r where r.hold_id = h.id);

-- ---------------------------------------------------------------------------------------------
-- Retention computation over the dependency graph
-- ---------------------------------------------------------------------------------------------

create function records.latest_inputs(p_schedule_id uuid) returns records.retention_input
language sql stable security definer set search_path = pg_catalog, records, kernel as $$
  select * from records.retention_input where schedule_id = p_schedule_id order by input_version desc limit 1
$$;

create function records.own_retention(p_schedule_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, records, kernel as $$
  select records.evaluate_retention(i.inputs || jsonb_build_object('retentionKey', s.retention_key))
  from records.retention_schedule s
  join lateral (select * from records.retention_input x where x.schedule_id = s.id order by x.input_version desc limit 1) i on true
  where s.id = p_schedule_id
$$;

-- Effective retention = the record's own rules plus every record that depends on it, transitively.
-- OPEN when any record in that closure is OPEN, or has no applicable rule and no dependants.
create function records.compute_effective_retention(p_schedule_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_nodes jsonb;
  v_open jsonb;
  v_max date;
  v_gov jsonb;
begin
  with recursive closure(schedule_id) as (
    select p_schedule_id
    union
    select d.dependant_schedule_id from records.retention_dependency d join closure c on d.supporting_schedule_id = c.schedule_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'recordKey', s.record_key,
           'own', records.own_retention(s.id),
           'hasDependants', exists (select 1 from records.retention_dependency d where d.supporting_schedule_id = s.id))
         order by s.record_key collate "C"), '[]'::jsonb)
  into v_nodes
  from closure c join records.retention_schedule s on s.id = c.schedule_id;
  if jsonb_array_length(v_nodes) = 0 then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-021 retention schedule %s does not exist', p_schedule_id);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('recordKey', n ->> 'recordKey',
                                               'reasons', case when n -> 'own' ->> 'status' = 'OPEN' then n -> 'own' -> 'openReasons'
                                                               else '["NO_RULE_APPLIES"]'::jsonb end)
                            order by n ->> 'recordKey' collate "C"), '[]'::jsonb)
  into v_open
  from jsonb_array_elements(v_nodes) n
  where n -> 'own' ->> 'status' = 'OPEN' or (n -> 'own' ->> 'status' = 'NONE' and not (n ->> 'hasDependants')::boolean);

  select max((n -> 'own' ->> 'retainUntil')::date) into v_max
  from jsonb_array_elements(v_nodes) n where n -> 'own' ->> 'status' = 'DATED';

  select coalesce(jsonb_agg(n ->> 'recordKey' order by n ->> 'recordKey' collate "C"), '[]'::jsonb) into v_gov
  from jsonb_array_elements(v_nodes) n
  where n -> 'own' ->> 'status' = 'DATED' and (n -> 'own' ->> 'retainUntil')::date = v_max;

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_open) > 0 then 'OPEN' else 'DATED' end,
    'retainUntil', case when jsonb_array_length(v_open) = 0 then to_char(v_max, 'YYYY-MM-DD') end,
    'latestDated', to_char(v_max, 'YYYY-MM-DD'),
    'governedBy', case when jsonb_array_length(v_open) = 0 then v_gov else '[]'::jsonb end,
    'openBecause', v_open,
    'recordsConsidered', jsonb_array_length(v_nodes));
end
$$;

-- Store a fresh evaluation for the schedule and every record it supports, transitively (internal).
create function records.refresh_retention(p_schedule_id uuid, p_cause text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_own jsonb;
  v_eff jsonb;
  v_last records.retention_evaluation%rowtype;
  v_input integer;
begin
  with recursive ancestors(schedule_id) as (
    select p_schedule_id
    union
    select d.supporting_schedule_id from records.retention_dependency d join ancestors a on d.dependant_schedule_id = a.schedule_id
  )
  select array_agg(schedule_id order by schedule_id) into v_ids from ancestors;
  perform 1 from records.retention_schedule where id = any(v_ids) order by id for update;
  foreach v_id in array v_ids loop
    v_own := records.own_retention(v_id);
    v_eff := records.compute_effective_retention(v_id);
    select input_version into v_input from records.latest_inputs(v_id);
    select * into v_last from records.retention_evaluation where schedule_id = v_id order by id desc limit 1;
    if found and v_last.own = v_own and v_last.effective = v_eff and v_last.input_version = v_input then
      continue;
    end if;
    insert into records.retention_evaluation (schedule_id, record_key, input_version, rule_set_version, own, effective,
                                              effective_status, effective_retain_until, cause)
    select v_id, s.record_key, v_input, v_own ->> 'ruleSetVersion', v_own, v_eff, v_eff ->> 'status', (v_eff ->> 'retainUntil')::date,
           case when v_id = p_schedule_id then p_cause else 'DEPENDANT_CHANGED' end
    from records.retention_schedule s where s.id = v_id;
  end loop;
end
$$;

create function records.schedule_for(p_record_key text) returns records.retention_schedule
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.retention_schedule%rowtype;
begin
  select * into v from records.retention_schedule where record_key = p_record_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-021 %s has no retention schedule', p_record_key);
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Public functions
-- ---------------------------------------------------------------------------------------------

create function records.create_retention_schedule(p_aggregate_type text, p_aggregate_id text, p_record_type_code text,
                                                  p_inputs jsonb, p_site_zone text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
  v_type records.record_register%rowtype;
  v_zone text := coalesce(p_site_zone, records.actor() ->> 'site_zone');
  v_inputs jsonb := records.normalize_retention_inputs(p_inputs);
  v_id uuid;
begin
  select * into v_type from records.record_register where code = p_record_type_code;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-013 record type %s has no approved version in the record register', p_record_type_code);
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_zone) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-020 site zone %L is not a known time zone', v_zone);
  end if;
  if p_aggregate_type in ('retention', 'retention_rule_set', 'record_hold', 'tombstone', 'true_copy') then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s records belong to the retention machinery and have no schedule', p_aggregate_type);
  end if;
  if exists (select 1 from records.retention_schedule where record_key = v_key) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s already has a retention schedule', v_key);
  end if;
  insert into records.retention_schedule (record_key, aggregate_type, aggregate_id, record_type_code, record_type_version,
                                          retention_key, site_zone, created_by_person)
  values (v_key, p_aggregate_type, p_aggregate_id, v_type.code, v_type.version, v_type.retention_key, v_zone, records.actor_person())
  returning id into v_id;
  insert into records.retention_input (schedule_id, record_key, input_version, inputs, change_reason, entered_by_person)
  values (v_id, v_key, 1, v_inputs, 'initial retention inputs', records.actor_person());
  perform records.refresh_retention(v_id, 'CREATED');
  return v_id;
end
$$;

-- p_changes holds only the inputs that change, e.g. {"euCertificationDate": "2026-03-10"}.
create function records.update_retention_inputs(p_record_key text, p_changes jsonb, p_change_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_sched records.retention_schedule%rowtype := records.schedule_for(p_record_key);
  v_last records.retention_input%rowtype;
  v_new jsonb;
begin
  if records.is_blank(p_change_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 a change to retention inputs needs a reason';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 retention input changes must be a JSON object';
  end if;
  perform 1 from records.retention_schedule where id = v_sched.id for update;
  if exists (select 1 from records.tombstone t where t.record_key = v_sched.record_key) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-023 %s has been purged', v_sched.record_key);
  end if;
  v_last := records.latest_inputs(v_sched.id);
  v_new := records.normalize_retention_inputs(v_last.inputs || p_changes);
  if v_new <> v_last.inputs then
    insert into records.retention_input (schedule_id, record_key, input_version, inputs, change_reason, entered_by_person)
    values (v_sched.id, v_sched.record_key, v_last.input_version + 1, v_new, p_change_reason, records.actor_person());
    perform records.refresh_retention(v_sched.id, 'INPUT_CHANGED');
  end if;
  return records.compute_effective_retention(v_sched.id);
end
$$;

create function records.link_retention_dependency(p_supporting_record_key text, p_dependant_record_key text, p_link_kind text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_sup records.retention_schedule%rowtype := records.schedule_for(p_supporting_record_key);
  v_dep records.retention_schedule%rowtype := records.schedule_for(p_dependant_record_key);
begin
  if v_sup.id = v_dep.id then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-022 a record cannot depend on itself';
  end if;
  if records.is_blank(p_link_kind) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-022 a retention dependency needs its kind (e.g. COMPONENT_LOT_CONSUMED)';
  end if;
  perform 1 from records.retention_schedule where id in (v_sup.id, v_dep.id) order by id for update;
  if exists (select 1 from records.retention_dependency where supporting_schedule_id = v_sup.id and dependant_schedule_id = v_dep.id) then
    return;
  end if;
  if exists (
    with recursive closure(schedule_id) as (
      select v_dep.id
      union
      select d.dependant_schedule_id from records.retention_dependency d join closure c on d.supporting_schedule_id = c.schedule_id
    )
    select 1 from closure where schedule_id = v_sup.id
  ) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-022 %s already depends on %s; the link would form a cycle', p_supporting_record_key, p_dependant_record_key);
  end if;
  insert into records.retention_dependency (supporting_schedule_id, dependant_schedule_id, supporting_record_key, dependant_record_key,
                                            link_kind, linked_by_person)
  values (v_sup.id, v_dep.id, v_sup.record_key, v_dep.record_key, p_link_kind, records.actor_person());
  perform records.refresh_retention(v_sup.id, 'DEPENDENCY_LINKED');
end
$$;

-- Holds -------------------------------------------------------------------------------------

-- Internal: place a hold and note it in the held record's own audit chain.
create function records.add_hold(p_kind text, p_aggregate_type text, p_aggregate_id text, p_reason text, p_reference text, p_investigation_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
  v_id uuid;
begin
  -- Lock first: a hold and a purge of the same record never interleave.
  perform records.lock_blocker_epoch(p_aggregate_type, p_aggregate_id);
  if exists (select 1 from records.tombstone t where t.record_key = v_key) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-040 %s has already been purged; nothing is left to hold', v_key);
  end if;
  insert into records.retention_hold (record_key, aggregate_type, aggregate_id, kind, reason, reference, investigation_id, placed_by_person)
  values (v_key, p_aggregate_type, p_aggregate_id, p_kind, p_reason, nullif(btrim(coalesce(p_reference, '')), ''), p_investigation_id, records.actor_person())
  on conflict do nothing
  returning id into v_id;
  if v_id is not null then
    perform kernel.audit_business_event(v_key, format('%s hold placed: %s', lower(replace(p_kind, '_', ' ')), p_reason),
                                        jsonb_build_object('hold_id', v_id, 'kind', p_kind, 'reference', p_reference, 'investigation_id', p_investigation_id));
    perform records.bump_blocker_epoch(p_aggregate_type, p_aggregate_id);
  end if;
  return v_id;
end
$$;

-- Internal: release a hold and note it in the held record's chain.
create function records.end_hold(p_hold records.retention_hold, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
begin
  insert into records.retention_hold_release (hold_id, record_key, reason, released_by_person)
  values (p_hold.id, p_hold.record_key, p_reason, records.actor_person());
  perform kernel.audit_business_event(p_hold.record_key, format('%s hold released: %s', lower(replace(p_hold.kind, '_', ' ')), p_reason),
                                      jsonb_build_object('hold_id', p_hold.id, 'kind', p_hold.kind));
  perform records.bump_blocker_epoch(p_hold.aggregate_type, p_hold.aggregate_id);
end
$$;

create function records.place_legal_hold(p_aggregate_type text, p_aggregate_id text, p_reason text, p_reference text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
begin
  if records.actor_is_machine() then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-040 a legal hold is placed by a person';
  end if;
  if records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-040 a legal hold needs a reason';
  end if;
  return records.add_hold('LEGAL', p_aggregate_type, p_aggregate_id, p_reason, p_reference, null);
end
$$;

create function records.release_legal_hold(p_hold_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.retention_hold%rowtype;
begin
  select * into v from records.retention_hold where id = p_hold_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-040 hold %s does not exist', p_hold_id);
  end if;
  if v.kind <> 'LEGAL' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-040 a DI-investigation hold is released only by closing its investigation';
  end if;
  if exists (select 1 from records.retention_hold_release where hold_id = p_hold_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-040 hold %s is already released', p_hold_id);
  end if;
  if records.actor_is_machine() or records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-040 a legal hold is released by a person, with a reason';
  end if;
  perform records.end_hold(v, p_reason);
end
$$;

select kernel.register_audited_table('records.retention_schedule', 'retention', 'record_key', true);
select kernel.register_audited_table('records.retention_input', 'retention', 'record_key', true);
select kernel.register_audited_table('records.retention_evaluation', 'retention', 'record_key', true);
select kernel.register_audited_table('records.retention_dependency', 'retention', 'supporting_record_key', true);
select kernel.register_audited_table('records.retention_hold', 'record_hold', 'record_key', true);
select kernel.register_audited_table('records.retention_hold_release', 'record_hold', 'record_key', true);
select kernel.register_audited_table('records.true_copy', 'true_copy', 'record_key', true);
select kernel.register_audited_table('records.purge_approval', 'retention', 'record_key', true);
select kernel.register_audited_table('records.tombstone', 'tombstone', 'record_key', true);

revoke all on records.retention_rule_set, records.retention_rule, records.retention_schedule, records.retention_input,
              records.retention_evaluation, records.retention_dependency, records.retention_hold, records.retention_hold_release,
              records.true_copy, records.purge_approval, records.tombstone from ebmr_app;
grant select on records.retention_rule_set, records.retention_rule, records.retention_schedule, records.retention_input,
                records.retention_evaluation, records.retention_dependency, records.retention_hold, records.retention_hold_release,
                records.active_hold, records.true_copy, records.purge_approval, records.tombstone to ebmr_app;
grant execute on function records.current_retention_rule_set(), records.evaluate_retention(jsonb, text),
                          records.normalize_retention_inputs(jsonb), records.compute_effective_retention(uuid),
                          records.create_retention_schedule(text, text, text, jsonb, text),
                          records.update_retention_inputs(text, jsonb, text),
                          records.link_retention_dependency(text, text, text),
                          records.place_legal_hold(text, text, text, text),
                          records.release_legal_hold(uuid, text) to ebmr_app;
-- refresh_retention, own_retention, latest_inputs, schedule_for, add_hold and end_hold stay private.

reset role;
