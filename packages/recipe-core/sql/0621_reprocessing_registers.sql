-- Recipe core, Phase 3 slice 5b (reprocessing and recovery, outline 5.2.9 cases 2 and 3; tablets spec K-24, TB-08;
-- D-S5-7; controls PR-47, IN-18, IN-19, PR-57, INV-33; ADR 0012: the rules hold when the application's own database
-- credentials are used directly). Part 2: the registers an addition stands on.
--
-- An addition (case 2, reprocessing addition; case 3, recovery) takes a weighed quantity from a closed output container
-- of an executed batch record, never ad-hoc material. The facts of the source are read from these registers, never
-- typed, and the quality unit authorises each use before it is made.
--
--   * permission REPROCESSING.AUTHORISE (SIGN; QA_SHOP_FLOOR): the quality unit's reservation of reject material for
--     reprocessing and its authorisation of a reprocessing step or of one use of a source container;
--   * signature meanings RESIDUE_RESERVED (on the output container: "reserved for reprocessing", quarantined) and
--     REPROCESSING_AUTHORISED (on a reprocessing authorisation; QCU approval before execution, citing the investigation
--     and the risk evaluation); no kernel meaning states either act;
--   * recipe.residue_reservation (insert-only, audited, one per container): a closed reject container the quality unit
--     reserved for reprocessing under its RESIDUE_RESERVED signature (recipe.reserve_residue). Which containers are
--     reusable residue is the edition's (recipe.residue_source_problem: none in recipe-core; the Tablets edition's TB-20
--     reusable-residue containers, tablets 1021);
--   * recipe.reprocessing_authorisation (insert-only, audited, signable aggregate reprocessing_authorisation): what the
--     quality unit is asked to authorise: a reprocessing step of a batch (scope STEP) or one use of one source container
--     at that step (scope USE), with its case from the MBR, the investigation and the risk evaluation it cites
--     (recipe.propose_reprocessing_authorisation); recipe.reprocessing_authorisation_signature: its REPROCESSING_AUTHORISED
--     signature, recorded once (recipe.authorise_reprocessing);
--   * recipe.source_addition (insert-only, audited): each addition with its source container, the quantity taken, the
--     source batch, product, strength, generation and manufacture instants and expiry, and the authorisation it used
--     (once). It is the genealogy edge source batch -> receiving batch (INV-33, PR-57); only the execution guards of
--     recipe-core 0622 and tablets 1021 write it, in the transaction of the entry. A container may be taken from in part
--     (D-S5-7 as amended, so GB-T-01's 3 % cap can be met): its remaining quantity is the closed net less what was taken,
--     and the insert guard never lets it go below zero (EBMR-RPR-040);
--   * readers: recipe.source_container_facts (what an addition entry carries), recipe.reprocessing_authorisation_facts,
--     recipe.batch_contains_recovered, recipe.batch_reprocessing_basis, recipe.recovered_expiry_cap, recipe.source_batch_expiry
--     (NULL until the product master's shelf life is read, 0623) and recipe.batches_receiving_from (forward trace).
--
-- New objects are owned by ebmr_owner and private to the owner except what the application uses: it reads the tables
-- and runs the commands and readers. Definers pin their search_path with pg_temp last. Messages: EBMR-RPR-010 to 029
-- (commands), 040 (remaining). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0621_reprocessing_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'permission and signature types of the quality unit''s reservation of residue and authorisation of reprocessing (PR-47, IN-19)'));

insert into iam.permission (code, domain, effect, description) values
  ('REPROCESSING.AUTHORISE', 'GMP', 'SIGN',
   'Quality unit: reserve reject material for reprocessing and authorise a reprocessing step or one use of a source container before execution');

insert into iam.role_permission (role_code, permission_code) values ('QA_SHOP_FLOOR', 'REPROCESSING.AUTHORISE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('RESIDUE_RESERVED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'AUTHORISER', 'Residue reserved for reprocessing',
   'Quality unit: I reserve the reject material in this container for reprocessing; it stays in quarantine and is used only through an authorised reprocessing addition.',
   array['REPROCESSING.AUTHORISE'], '{}', true, false, false, 'ALL_COMPONENTS', false,
   'Outline 5.2.9 case 2 (reusable residue reserved for reprocessing); tablets spec TB-20, TB-08; PR-47'),
  ('REPROCESSING_AUTHORISED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'AUTHORISER', 'Reprocessing authorised',
   'Quality unit: I authorise this reprocessing or this use of recovered or reprocessed material before it is carried out, on the investigation and the risk evaluation cited.',
   array['REPROCESSING.AUTHORISE'], '{}', false, false, false, 'ALL_COMPONENTS', false,
   'Outline 5.2.9 cases 1 to 3; tablets spec K-24, TB-08; PR-47, IN-19');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table recipe.residue_reservation (
  container_id         uuid primary key references plant.output_container (id),
  signature_id         uuid not null unique,
  reserved_by_person   uuid not null,
  reserved_by_account  uuid not null,
  correlation_id       uuid not null,
  reserved_at          timestamptz not null default clock_timestamp()
);
revoke all on recipe.residue_reservation from public;

create table recipe.reprocessing_authorisation (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references recipe.batch_execution (id),
  step_id              text not null check (step_id ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
  scope                text not null check (scope in ('STEP', 'USE')),
  container_id         uuid references plant.output_container (id),
  case_code            text not null check (case_code in ('WHOLE_BATCH_REPROCESSING', 'REPROCESSING_ADDITION', 'RECOVERY')),
  investigation_ref    text not null check (btrim(investigation_ref) <> '' and length(investigation_ref) <= 200),
  risk_evaluation_ref  text not null check (btrim(risk_evaluation_ref) <> '' and length(risk_evaluation_ref) <= 200),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  correlation_id       uuid not null,
  proposed_at          timestamptz not null default clock_timestamp(),
  check ((scope = 'USE') = (container_id is not null)),
  check (scope = 'STEP' or case_code in ('REPROCESSING_ADDITION', 'RECOVERY'))
);
revoke all on recipe.reprocessing_authorisation from public;
create index reprocessing_authorisation_batch on recipe.reprocessing_authorisation (batch_id, step_id);

create table recipe.reprocessing_authorisation_signature (
  authorisation_id     uuid primary key references recipe.reprocessing_authorisation (id),
  signature_id         uuid not null unique,
  signer_person        uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
revoke all on recipe.reprocessing_authorisation_signature from public;

create table recipe.source_addition (
  id                       uuid primary key default gen_random_uuid(),
  batch_id                 uuid not null references recipe.batch_execution (id),
  batch_number             text not null,
  step_key                 text not null check (btrim(step_key) <> ''),
  entry_id                 text not null check (entry_id ~ '^EN-[1-9][0-9]{0,8}$'),
  block                    text not null check (block in ('G-24@2', 'TB-08@1')),
  container_id             uuid not null references plant.output_container (id),
  case_code                text not null check (case_code in ('REPROCESSING_ADDITION', 'RECOVERY')),
  net_quantity             numeric not null check (net_quantity > 0),
  unit                     text not null check (unit in ('kg', 'g', 'units')),
  source_batch_id          uuid not null references recipe.batch_execution (id),
  source_batch_number      text not null,
  product_code             text not null,
  strength                 text not null,
  source_generated_at      timestamptz not null,
  source_manufactured_at   timestamptz not null,
  source_expiry            date,
  authorisation_id         uuid unique references recipe.reprocessing_authorisation (id),
  added_by_person          uuid not null,
  recorded_at              timestamptz not null default clock_timestamp(),
  unique (batch_id, entry_id),
  check (source_batch_id <> batch_id)
);
revoke all on recipe.source_addition from public;
create index source_addition_container on recipe.source_addition (container_id);
create index source_addition_source on recipe.source_addition (source_batch_id);

create trigger aa_insert_only before update or delete on recipe.residue_reservation for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.residue_reservation for each statement execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on recipe.reprocessing_authorisation for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.reprocessing_authorisation for each statement execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on recipe.reprocessing_authorisation_signature for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.reprocessing_authorisation_signature for each statement execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on recipe.source_addition for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.source_addition for each statement execute function kernel.reject_mutation();

select platform.enforce_db_time('recipe.residue_reservation', array['reserved_at']);
select platform.enforce_db_time('recipe.reprocessing_authorisation', array['proposed_at']);
select platform.enforce_db_time('recipe.reprocessing_authorisation_signature', array['recorded_at']);
select platform.enforce_db_time('recipe.source_addition', array['recorded_at']);

select kernel.register_audited_table('recipe.residue_reservation', 'output_container', 'container_id', true);
select kernel.register_audited_table('recipe.reprocessing_authorisation', 'reprocessing_authorisation', 'id', true);
select kernel.register_audited_table('recipe.reprocessing_authorisation_signature', 'reprocessing_authorisation', 'authorisation_id', true);
select kernel.register_audited_table('recipe.source_addition', 'batch', 'batch_id', true);

grant select on recipe.residue_reservation, recipe.reprocessing_authorisation, recipe.reprocessing_authorisation_signature,
                recipe.source_addition to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------------------------

-- An instant as epoch microseconds (digits).
create function recipe.rpr_micros(p timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (extract(epoch from p) * 1000000)::numeric(20, 0)::text
$$;

-- Why output container p_container is not reusable residue of the edition, or NULL (header). recipe-core knows no block
-- that marks residue, so none is; an edition replaces this function (tablets 1021: TB-20 reusable residue).
create function recipe.residue_source_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
begin
  return 'no block of this edition marks reusable residue';
end
$$;

-- IN-19 (b): the expiry month of the material of source batch p_batch (its first day), or NULL when it is not known:
-- the product master's shelf life is read from 0623 on (D-S5-7: manufacturing month plus shelf life, the print rule).
create function recipe.source_batch_expiry(p_batch uuid) returns date
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select null::date
$$;

-- INV-33, IN-19: whether batch p_batch contains recovered or reprocessed material (an addition was recorded into it).
create function recipe.batch_contains_recovered(p_batch uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select exists (select 1 from recipe.source_addition a where a.batch_id = p_batch)
$$;

-- What is still in closed container p_container: its closed net less what additions took (NULL when not closed).
create function recipe.container_remaining(p_container uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select x.net_quantity - coalesce((select sum(a.net_quantity) from recipe.source_addition a where a.container_id = p_container), 0)
    from plant.container_close x where x.container_id = p_container
$$;

-- PR-47, IN-19 (header): the facts of output container p_container as a source for batch p_batch, as an addition entry
-- carries them (blocks/generic/reprocessing.ts SOURCE_FACTS_SCHEMA); NULL when it is no closed output container.
-- case: REPROCESSING_ADDITION for residue the quality unit reserved (still CLOSED), RECOVERY for a container released by
-- QA that is no reserved residue; absent when neither.
create function recipe.source_container_facts(p_container uuid, p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  o       plant.output_container;
  x       plant.container_close;
  b       recipe.batch_execution;
  v_state text;
  v_case  text;
begin
  select * into o from plant.output_container where id = p_container;
  select * into x from plant.container_close where container_id = p_container;
  if o.id is null or x.container_id is null then
    return null;
  end if;
  select * into b from recipe.batch_execution where id = o.batch_id;
  v_state := plant.container_state(o.id);
  v_case := case
    when exists (select 1 from recipe.residue_reservation r where r.container_id = o.id) then case when v_state = 'CLOSED' then 'REPROCESSING_ADDITION' end
    when v_state = 'RELEASED_BY_QA' then 'RECOVERY'
  end;
  if exists (select 1 from plant.container_charge c where c.container_id = o.id)
     or exists (select 1 from plant.container_merge m where m.source_id = o.id) then
    v_case := null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'container', o.id, 'sourceBatchId', o.batch_id, 'product', o.product_code, 'strength', o.strength, 'stage', o.stage,
    'unit', o.quantity_unit, 'case', v_case, 'generatedAtUs', recipe.rpr_micros(x.closed_at), 'manufacturedAtUs', b.issued_at_us::text,
    'containsRecovered', recipe.batch_contains_recovered(o.batch_id),
    'remaining', trim_scale(recipe.container_remaining(o.id))::text,
    'expiry', to_char(recipe.source_batch_expiry(o.batch_id), 'YYYY-MM')));
end
$$;

-- PR-47: the facts of reprocessing authorisation p_id once signed: {id, batchId, step, scope, container, case, signedBy};
-- NULL when it does not exist or is not signed.
create function recipe.reprocessing_authorisation_facts(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object('id', a.id, 'batchId', a.batch_id, 'step', a.step_id, 'scope', a.scope, 'container', a.container_id,
                                              'case', a.case_code, 'signedBy', s.signer_person))
    from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
   where a.id = p_id
$$;

-- PR-47, D-S5-9: the reprocessing basis of batch p_batch for the release checklist: REPROCESSING_ADDITION when material
-- reprocessed from rejects was added (case 2), RECOVERY when only recovered conforming material was (case 3), NULL
-- otherwise. 0623 adds WHOLE_BATCH (case 1).
create function recipe.batch_reprocessing_basis(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when exists (select 1 from recipe.source_addition a where a.batch_id = p_batch and a.case_code = 'REPROCESSING_ADDITION') then 'REPROCESSING_ADDITION'
           when exists (select 1 from recipe.source_addition a where a.batch_id = p_batch) then 'RECOVERY'
         end
$$;

-- IN-19 (b): the latest expiry batch p_batch may carry because of what was added to it: the first instant (UTC) of the
-- earliest expiry month among its recovered inputs; NULL when nothing with a known expiry was added.
create function recipe.recovered_expiry_cap(p_batch uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select (min(a.source_expiry)::timestamp at time zone 'UTC') from recipe.source_addition a where a.batch_id = p_batch and a.source_expiry is not null
$$;

-- INV-33, PR-57: the forward trace of source batch p_batch: every batch material of it was added to, with the containers
-- and quantities, in the order recorded.
create function recipe.batches_receiving_from(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('batchId', a.batch_id, 'batchNumber', a.batch_number, 'stepKey', a.step_key, 'entry', a.entry_id,
                                               'container', a.container_id, 'quantity', trim_scale(a.net_quantity)::text, 'unit', a.unit, 'case', a.case_code)
                            order by a.recorded_at, a.id), '[]'::jsonb)
    from recipe.source_addition a where a.source_batch_id = p_batch
$$;

-- ---------------------------------------------------------------------------------------------
-- The remaining quantity (header): an addition never takes more than its container still holds.
-- ---------------------------------------------------------------------------------------------

create function recipe.source_addition_remaining_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_left numeric;
begin
  perform pg_advisory_xact_lock(hashtext('recipe.source_container:' || new.container_id::text));
  v_left := recipe.container_remaining(new.container_id);
  if v_left is null or new.net_quantity > v_left then
    raise exception using errcode = 'P0001',
      message = format('Container %s holds %s %s; %s cannot be taken from it: its remaining quantity never goes below zero (PR-47, INV-33). [EBMR-RPR-040]',
                       new.container_id, coalesce(trim_scale(v_left)::text, 'nothing (it is not closed)'), new.unit, trim_scale(new.net_quantity)::text);
  end if;
  if (select o.quantity_unit from plant.output_container o where o.id = new.container_id) is distinct from new.unit then
    raise exception using errcode = 'P0001',
      message = format('Container %s is not counted in %s: an addition is taken in its container''s unit (PR-47). [EBMR-RPR-040]', new.container_id, new.unit);
  end if;
  return new;
end
$$;

create trigger ab_source_addition_remaining before insert on recipe.source_addition
  for each row execute function recipe.source_addition_remaining_check();

-- ---------------------------------------------------------------------------------------------
-- Signable content of an authorisation
-- ---------------------------------------------------------------------------------------------

create function recipe.reprocessing_authorisation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  a recipe.reprocessing_authorisation;
  b recipe.batch_execution;
  o plant.output_container;
  x plant.container_close;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into a from recipe.reprocessing_authorisation where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = a.batch_id;
  select * into o from plant.output_container where id = a.container_id;
  select * into x from plant.container_close where container_id = a.container_id;
  return jsonb_build_object(
    'exists', true,
    'aggregate_id', a.id::text,
    'content_version', 1,
    'content', jsonb_build_object(
      'title', format('Reprocessing authorisation: %s step %s (%s)', b.batch_number, a.step_id, lower(replace(a.case_code, '_', ' '))),
      'batch_id', a.batch_id, 'batch_number', b.batch_number, 'product', recipe.batch_product(a.batch_id), 'step', a.step_id, 'scope', a.scope,
      'case', a.case_code, 'investigation_ref', a.investigation_ref, 'risk_evaluation_ref', a.risk_evaluation_ref,
      'source_container', case when o.id is null then null else jsonb_build_object(
        'id', o.id, 'label_code', o.label_code, 'batch_id', o.batch_id, 'batch_number', o.batch_number, 'product_code', o.product_code,
        'strength', o.strength, 'stage', o.stage, 'net_quantity', x.net_quantity::text, 'quantity_unit', o.quantity_unit, 'closed_at', x.closed_at) end,
      'proposed_by', a.proposed_by_person, 'proposed_at', recipe.utc_text(a.proposed_at)),
    'state', 'PROPOSED',
    'scope', jsonb_build_object('product', recipe.batch_product(a.batch_id) ->> 'code'),
    'entered_by', jsonb_build_array(a.proposed_by_person));
end
$$;

select esig.register_content_provider('reprocessing_authorisation', 'recipe.reprocessing_authorisation_content(text)',
  'A request for the quality unit''s authorisation of a reprocessing step or of one use of a source container: batch, step, case, source, investigation and risk evaluation (outline 5.2.9; PR-47, IN-19)');
select esig.register_signed_table('recipe.reprocessing_authorisation', 'reprocessing_authorisation', 'id',
  array['batch_id', 'step_id', 'scope', 'container_id', 'case_code', 'investigation_ref', 'risk_evaluation_ref', 'proposed_by_person', 'proposed_at']);

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- PR-47 (header): the quality unit reserves closed reject container p_container for reprocessing under its signature
-- p_signature (RESIDUE_RESERVED on the output container, given in its current state). Returns {container_id}.
create function recipe.reserve_residue(p_container uuid, p_signature uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, iam, esig, pg_temp as $$
declare
  v_actor   jsonb;
  o         plant.output_container;
  v_problem text;
  v_signer  uuid;
begin
  perform iam.assert_not_administrator();
  select * into o from plant.output_container where id = p_container;
  if not found then
    raise exception using errcode = 'P0001', message = format('Container %s is not an output container of this site (PR-47). [EBMR-RPR-010]', p_container);
  end if;
  v_actor := iam.require_permission('REPROCESSING.AUTHORISE', plant.container_scope(p_container));
  perform pg_advisory_xact_lock(hashtext('recipe.source_container:' || p_container::text));
  if plant.container_state(p_container) is distinct from 'CLOSED' then
    raise exception using errcode = 'P0001',
      message = format('Container %s is %s: only a closed reject container is reserved for reprocessing (PR-47). [EBMR-RPR-010]', o.label_code, coalesce(plant.container_state(p_container), 'unknown'));
  end if;
  if exists (select 1 from plant.container_charge c where c.container_id = p_container) or exists (select 1 from plant.container_merge m where m.source_id = p_container or m.target_id = p_container) then
    raise exception using errcode = 'P0001', message = format('Container %s was charged, packed or merged; it is no residue to reserve (PR-47). [EBMR-RPR-010]', o.label_code);
  end if;
  v_problem := recipe.residue_source_problem(p_container);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('Container %s is not reusable residue: %s (PR-47, IN-19). [EBMR-RPR-010]', o.label_code, v_problem);
  end if;
  if exists (select 1 from recipe.residue_reservation r where r.container_id = p_container) then
    raise exception using errcode = 'P0001', message = format('Container %s is already reserved for reprocessing (PR-47). [EBMR-RPR-010]', o.label_code);
  end if;
  v_signer := (esig.assert_signature(p_signature, 'RESIDUE_RESERVED', 'output_container', p_container::text) ->> 'signer_person')::uuid;
  if v_signer is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'The quality unit records its own reservation: the signer is the person who reserves (PR-47). [EBMR-RPR-011]';
  end if;
  insert into recipe.residue_reservation (container_id, signature_id, reserved_by_person, reserved_by_account, correlation_id)
  values (p_container, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('container_id', p_container);
end
$$;

-- PR-47, IN-19 (header): asks the quality unit to authorise reprocessing step p_step of batch p_batch (p_container NULL)
-- or one use of source container p_container at that step, citing investigation p_investigation and risk evaluation
-- p_risk. The case is the step's in the batch's MBR. Returns {id}.
create function recipe.propose_reprocessing_authorisation(p_batch uuid, p_step text, p_container uuid, p_investigation text, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_node  jsonb;
  v_case  text;
  o       plant.output_container;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution b where b.id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Batch %s does not exist (PR-47). [EBMR-RPR-020]', p_batch);
  end if;
  v_actor := iam.require_permission('REPROCESSING.AUTHORISE', plant.batch_scope(p_batch));
  if (select s.status from recipe.execution_state s where s.batch_id = p_batch) not in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD') then
    raise exception using errcode = 'P0001', message = 'A reprocessing is authorised before it is carried out, on a batch still in execution (PR-47). [EBMR-RPR-020]';
  end if;
  v_node := recipe.step_node(recipe.batch_mbr_content(p_batch), p_step);
  v_case := v_node -> 'reprocessing' ->> 'case';
  if v_node ->> 'kind' is distinct from 'phase' or v_case is null or v_case = 'VALIDATED_RETREATMENT'
     or (v_node -> 'block' ->> 'type', v_node -> 'block' ->> 'version') not in (('G-24', '1'), ('G-24', '2'), ('TB-08', '1')) then
    raise exception using errcode = 'P0001',
      message = format('Step %s is no reprocessing or recovery step of the batch''s MBR (a G-24 or TB-08 step that declares its case) (PR-47). [EBMR-RPR-020]', coalesce(p_step, '(none)'));
  end if;
  if p_container is not null then
    if v_case not in ('REPROCESSING_ADDITION', 'RECOVERY') then
      raise exception using errcode = 'P0001', message = format('Step %s adds no material: its authorisation names no container (PR-47). [EBMR-RPR-020]', p_step);
    end if;
    select * into o from plant.output_container where id = p_container;
    if o.id is null or not exists (select 1 from plant.container_close x where x.container_id = p_container) or o.batch_id = p_batch then
      raise exception using errcode = 'P0001',
        message = 'Only a closed output container of an earlier batch record is a source; ad-hoc material is never added (PR-47, IN-19). [EBMR-RPR-020]';
    end if;
  end if;
  if btrim(coalesce(p_investigation, '')) = '' or btrim(coalesce(p_risk, '')) = '' then
    raise exception using errcode = 'P0001', message = 'The authorisation cites the investigation and the risk evaluation it rests on (PR-47, IN-19). [EBMR-RPR-020]';
  end if;
  insert into recipe.reprocessing_authorisation (batch_id, step_id, scope, container_id, case_code, investigation_ref, risk_evaluation_ref,
                                                 proposed_by_person, proposed_by_account, correlation_id)
  values (p_batch, p_step, case when p_container is null then 'STEP' else 'USE' end, p_container, v_case, btrim(p_investigation), btrim(p_risk),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end
$$;

-- PR-47 (header): the quality unit records its REPROCESSING_AUTHORISED signature p_signature on authorisation p_id, once.
create function recipe.authorise_reprocessing(p_id uuid, p_signature uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, iam, esig, pg_temp as $$
declare
  a        recipe.reprocessing_authorisation;
  v_actor  jsonb;
  v_signer uuid;
begin
  perform iam.assert_not_administrator();
  select * into a from recipe.reprocessing_authorisation where id = p_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('There is no reprocessing authorisation %s (PR-47). [EBMR-RPR-021]', p_id);
  end if;
  v_actor := iam.require_permission('REPROCESSING.AUTHORISE', plant.batch_scope(a.batch_id));
  perform pg_advisory_xact_lock(hashtext('recipe.reprocessing_authorisation:' || p_id::text));
  if exists (select 1 from recipe.reprocessing_authorisation_signature s where s.authorisation_id = p_id) then
    raise exception using errcode = 'P0001', message = 'This reprocessing authorisation is already signed (PR-47). [EBMR-RPR-021]';
  end if;
  v_signer := (esig.assert_signature(p_signature, 'REPROCESSING_AUTHORISED', 'reprocessing_authorisation', p_id::text) ->> 'signer_person')::uuid;
  if v_signer is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'The quality unit records its own authorisation: the signer is the person who records it (PR-47). [EBMR-RPR-021]';
  end if;
  insert into recipe.reprocessing_authorisation_signature (authorisation_id, signature_id, signer_person, recorded_by_account)
  values (p_id, p_signature, v_signer, (v_actor ->> 'account_id')::uuid);
  return recipe.reprocessing_authorisation_facts(p_id);
end
$$;

revoke all on function recipe.rpr_micros(timestamptz), recipe.residue_source_problem(uuid), recipe.source_batch_expiry(uuid),
  recipe.batch_contains_recovered(uuid), recipe.container_remaining(uuid), recipe.source_container_facts(uuid, uuid),
  recipe.reprocessing_authorisation_facts(uuid), recipe.batch_reprocessing_basis(uuid), recipe.recovered_expiry_cap(uuid),
  recipe.batches_receiving_from(uuid), recipe.source_addition_remaining_check(), recipe.reprocessing_authorisation_content(text),
  recipe.reserve_residue(uuid, uuid), recipe.propose_reprocessing_authorisation(uuid, text, uuid, text, text),
  recipe.authorise_reprocessing(uuid, uuid) from public;

grant execute on function recipe.source_container_facts(uuid, uuid), recipe.reprocessing_authorisation_facts(uuid),
  recipe.batch_contains_recovered(uuid), recipe.container_remaining(uuid), recipe.batch_reprocessing_basis(uuid),
  recipe.recovered_expiry_cap(uuid), recipe.batches_receiving_from(uuid), recipe.reprocessing_authorisation_content(text),
  recipe.reserve_residue(uuid, uuid), recipe.propose_reprocessing_authorisation(uuid, text, uuid, text, text),
  recipe.authorise_reprocessing(uuid, uuid) to ebmr_app;

reset role;
