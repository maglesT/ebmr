-- Recipe core: market dispositions, QP certification intake, market add and removal, interfaces (Phase 4 slice 4-0;
-- outline 3.3.3, 5.2.6, 5.2.7 items 8 and 11, 5.7; INV-39, INV-43, PR-54, PR-55, PR-56, DI-39, DI-30; D-P4-5; plan
-- docs/build-plan/phase-4/phase-4-plan.md "Interfaces fixed up front"; ADR 0012, ADR 0013).
--
-- Fixed here (changed only through the lead); slice 4a fills the bodies by new migrations from these definitions, 4b
-- (package and shipping) and 4c (screens) build on them:
--
--   recipe.market_set(subject_kind text, subject_id uuid) returns text[]   STABLE. The market set of a BATCH (an issued
--       batch: its issued set) or a LOT (a finished lot: the set it was posted with) now: the original set plus every
--       market added and minus every market removed by a signed market change (3.3.3), sorted. NULL for an unknown
--       subject. 4-0: the original set (no changes yet).
--   recipe.disposition_state(lot uuid, market text) returns text   STABLE. IN: recipe.manufacturer_release_state(lot).
--       US: NOT_READY -> READY (computed: G-REL for US ready) -> RELEASED or REJECTED (the QCU's decision).
--       EU: NOT_READY -> AWAITING_QP_CERTIFICATION (computed: manufacturer release RELEASED and G-REL for EU ready) ->
--           CERTIFIED or REJECTED_BY_QP (a verified certification outcome: a signed message, a verified transcription or an
--           in-system QP signature).
--       Both: INELIGIBLE (terminal: the evaluation signed with the market's addition had an UNMET_FINAL item, 3.3.3);
--             RELEASE_SUSPENDED (a market RELEASED or CERTIFIED whose manufacturer release is no longer RELEASED: the
--             INV-39 cascade); REMOVED (the market was removed from the lot's set). NULL when the market was never in the
--             lot's set. 4b's shipping interlock reads it (INV-42: US only RELEASED; EU only AWAITING_QP_CERTIFICATION
--             to the named importer, in quarantine, or CERTIFIED). 4-0: IN as above, NOT_READY for a US or EU market in
--             the set.
--   recipe.market_add_evaluate(subject_kind text, subject_id uuid, market text) returns jsonb   STABLE. The market-add
--       evaluation against the recorded data (3.3.3):
--         {"subject_kind": "BATCH"|"LOT", "subject_id": uuid, "market": text, "outcome": "MET"|"UNMET_RECOVERABLE"|
--          "UNMET_FINAL", "items": [{"id": "MA.<NAME>", "title": text, "outcome": ..., "detail": text|null,
--          "evidence": [{"kind", "ref", "label"}]}]}
--       the worst item decides the outcome. 4-0: one UNMET_RECOVERABLE item (not evaluated yet; fails closed).
--   recipe.suspend_release(lot uuid, cause jsonb) returns void   owner only (slice 5's triggers call it): suspends the
--       manufacturer release of a RELEASED lot and, in the same transaction, every dependent market disposition (INV-39,
--       L-19). 4-0: refuses (EBMR-DSP-001); slice 5 builds the manufacturer side, 4a the market cascade it calls.
--   recipe.eu_importer, recipe.eu_importer_product   the EU importers named in technical agreements (one importer per
--       product), with the Ed25519 key their certification messages are signed with; written by QA's signed act (4a).
--   recipe.eu_importer_of(lot uuid) returns jsonb   the importer of the lot's product ({importer_id, code, name,
--       technical_agreement_ref, mia_number, key_fingerprint}) or NULL (4b: "EU lots only to the named importer").
--
-- Signed aggregates and meanings (4a; tablets 1189 maps them for the ceremony):
--   us_disposition          <lot>/<RELEASE|REJECT>                     US_DISPOSITION (kernel 0210; the QCU role)
--   market_change           <LOT|BATCH>/<id>/<ADD|REMOVE>/<market>    MARKET_ADDED, MARKET_REMOVED (QA; new)
--   qp_transcription        <lot>/<sha256 of the canonical details>   QP_CERTIFICATION_RECORDED (kernel 0210)
--   qp_transcription_check  <transcription id>                         QP_CERTIFICATION_VERIFIED (another QA person; new)
--   qp_certification        <lot>/<CERTIFIED|REJECTED_BY_QP>           QP_CERTIFIED (kernel 0210; registered QP, switch on)
--   eu_importer             <code>/<sha256 of the definition>          EU_IMPORTER_APPROVED (QA; new)
-- D-P4-5: a MANUFACTURER_RELEASE and a US_DISPOSITION signature of the same person, made in one ceremony, recorded by
-- one act in one transaction (recipe.record_release_with_us_disposition, 4a).
-- Messages: EBMR-DSP-001 to EBMR-DSP-099 (slice 4a).

set local role ebmr_owner;

create table recipe.eu_importer (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  name                     text not null check (btrim(name) <> '' and length(name) <= 200),
  technical_agreement_ref  text not null check (btrim(technical_agreement_ref) <> '' and length(technical_agreement_ref) <= 128),
  mia_number               text not null check (btrim(mia_number) <> '' and length(mia_number) <= 64),
  public_key               bytea not null check (length(public_key) = 32),
  key_fingerprint          text not null generated always as (encode(sha256(public_key), 'hex')) stored,
  signature_id             uuid not null unique,
  person_id                uuid not null,
  account_id               uuid not null,
  recorded_at              timestamptz not null default clock_timestamp()
);

create table recipe.eu_importer_product (
  product_code  text primary key check (product_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  importer_id   uuid not null references recipe.eu_importer (id),
  recorded_at   timestamptz not null default clock_timestamp()
);

do $$
declare
  t text;
begin
  foreach t in array array['eu_importer', 'eu_importer_product'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('recipe.eu_importer', array['recorded_at']);
select platform.enforce_db_time('recipe.eu_importer_product', array['recorded_at']);
select kernel.register_audited_table('recipe.eu_importer', 'eu_importer', 'code', true);
select kernel.register_audited_table('recipe.eu_importer_product', 'eu_importer', 'product_code', true);

create function recipe.market_set(p_kind text, p_id uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case p_kind
           when 'BATCH' then (select array(select distinct m from unnest(b.market_set) m order by m) from recipe.batch_execution b where b.id = p_id)
           when 'LOT' then (select array(select distinct m from unnest(f.markets) m order by m) from site.finished_lot f where f.lot_id = p_id)
         end
$$;

create function recipe.disposition_state(p_lot uuid, p_market text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  if p_market = 'IN' then
    return recipe.manufacturer_release_state(p_lot);
  end if;
  if p_market is null or p_market not in ('US', 'EU') or not (p_market = any (coalesce(recipe.market_set('LOT', p_lot), '{}'))) then
    return null;
  end if;
  return 'NOT_READY';
end
$$;

create function recipe.market_add_evaluate(p_kind text, p_id uuid, p_market text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('subject_kind', p_kind, 'subject_id', p_id, 'market', p_market, 'outcome', 'UNMET_RECOVERABLE',
                            'items', jsonb_build_array(jsonb_build_object('id', 'MA.PENDING', 'title', 'Market-add evaluation',
                                                                          'outcome', 'UNMET_RECOVERABLE', 'detail', 'not evaluated yet (slice 4a)',
                                                                          'evidence', '[]'::jsonb)))
$$;

-- Owner only: slice 5's triggers call it; 4-0 refuses.
create function recipe.suspend_release(p_lot uuid, p_cause jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = format('EBMR-DSP-001 the suspension of a released lot arrives with slice 5 (lot %s)', coalesce(p_lot::text, 'NULL'));
end
$$;

create function recipe.eu_importer_of(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select jsonb_build_object('importer_id', i.id, 'code', i.code, 'name', i.name, 'technical_agreement_ref', i.technical_agreement_ref,
                            'mia_number', i.mia_number, 'key_fingerprint', i.key_fingerprint)
    from site.finished_lot f join recipe.eu_importer_product p on p.product_code = f.product_code join recipe.eu_importer i on i.id = p.importer_id
   where f.lot_id = p_lot
$$;

revoke all on function recipe.market_set(text, uuid), recipe.disposition_state(uuid, text), recipe.market_add_evaluate(text, uuid, text),
                       recipe.suspend_release(uuid, jsonb), recipe.eu_importer_of(uuid) from public;
grant execute on function recipe.market_set(text, uuid), recipe.disposition_state(uuid, text), recipe.market_add_evaluate(text, uuid, text),
                          recipe.eu_importer_of(uuid) to ebmr_app;

reset role;
