-- Recipe core, execution store (module C3): an entry and a step's start data meet the data schema of the step's block
-- version, as the engine checks them before the block sees them, and an entry is of a kind that block records (Phase 2
-- exit review F12, the round-5 verification; DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47; ADR 0012: the rules
-- hold when the application's own database credentials are used directly).
--
-- Correction of 0330's header and of decision F12.3, stated here because applied migrations are never edited. 0330 said
-- a new entry holds exactly the data its block builds "and nothing else", and F12.3 that the accept rules are applied
-- "never weaker than the engine". Neither held. The engine checks every entry against its block version's data schema
-- before the block accepts it, and refuses an entry kind the step's block does not record (engine steps.ts recordEntry:
-- ENG-ENTRY-KIND, ENG-ENTRY-SCHEMA; startStep: the start data likewise; blocks/schema.ts validateSchema: unknown members,
-- missing required members, types, text patterns, enumerations, whole-number bounds, list lengths). 0330 applies none
-- of these. Where a block keeps or copies the command (a weighing, an output, a disposal, a transfer, a source
-- addition, start data), 0330 builds the data it compares from the command itself, so a member forged into the command
-- and the data alike passed; and an entry of a kind no block of its step records fell to 0330's ELSE branch, which
-- checks nothing. Through the application role the round-5 verification stored, each 'ok' with no violation reported:
-- a dispensing weighing at p-disp-pcm@ whose command and data both carried lotNumber 'L2409-0017' (a real-format lot
-- number in a test run's record, DI-05); a line clearance answering NO_PREVIOUS_MATERIAL 'NO' and an equipment status
-- answering DAILY_CHECK 'no', both stored as passed with no exception (0330 derives passed from the answers
-- NOT_CONFIRMED and NO only); and, at SQL level, G-24 start data {} or holding authorisedBy alone (G24-NOT-AUTHORISED
-- read only that some start data exists), a source addition without manufacturedAtUs or with it as a JSON number (0330
-- checks the age only of a digit string, so G24-TOO-OLD was skipped), checklist answers outside their lists, a sample of
-- 0 units, a disposal of category 'RETURN' with no method, and an unknown member in both the command and the data of
-- every block that keeps or copies the command. 0330 binds the members a block builds, and the accept rules it names;
-- the members a block takes from the command were held only to the command.
--
-- The same hole, read for this migration in every entry kind of the blocks of this release (blocks/generic) and in the
-- start data:
--   * ACKNOWLEDGE (G-03): a mode outside READ and CONFIRM_PERFORMED, a sopVersion that is no text, any other member, in
--     the command (its data is built from the MBR, 0330);
--   * ATTACHMENT (G-05): a sha256 that is not 64 lower-case hexadecimal digits, an empty media type or description, a
--     paperOriginal that is no boolean (0330 reads only the value true, so "true" as text needed no second person);
--   * CONTAINER_WEIGHING (G-07) and CHARGE_LOT (G-08): any other member (the verifier's lotNumber); a lot with another
--     member, without id, material or status, a status outside the eight the blocks know, an expiry or retest that is
--     not a digit string (0330 skips the date then), an identity-test flag that is no boolean (0330 reads only false);
--     gross and tare that are not decimal text; a source outside DEVICE and MANUAL (only MANUAL asks for the second
--     person); a lot charge's quantity of another shape;
--   * CHARGE_CONTAINER (G-08) and PREVIOUS_BATCH (G-10): an empty or non-text member, any other member;
--   * OUTPUT_CONTAINER (G-22): as the weighing (a container named is text);
--   * DISPOSAL (G-23): a category outside the four (a 'RETURN' escapes G23-BATCH-CODED and G23-METHOD), batchCoded that
--     is no boolean (0330 reads only true), a quantity of another shape, a method or container that is no text;
--   * EQUIPMENT_STATUS (G-09) and CLEARANCE_CHECK (G-10): an answer outside YES/NO, or CONFIRMED / NOT_CONFIRMED /
--     NOT_APPLICABLE (the step then shows passed), a check id that is not an upper-case id, an answer object with any
--     other member, more than 20 or 40 answers;
--   * SAMPLE (G-12): units that are not a whole number from 1 to 100000;
--   * TRANSFER_ISSUED and TRANSFER_RECEIVED (G-15): any other member (the block keeps the whole command), a quantity of
--     another shape;
--   * SOURCE_ADDITION (G-24): no manufacturedAtUs, or one that is no digit string (G24-TOO-OLD skipped), a
--     containsRecovered flag that is no boolean (0330 reads only true, so G24-CHAINED was skipped), no quantity, any
--     other member;
--   * START_DATA (G-24): start data without the investigation, risk evaluation and authorisation references and the
--     authoriser (G24-NOT-AUTHORISED), any other member; start data at a step whose block takes none;
--   * any entry kind its step's block does not record (0330's ELSE branch; 0321, 0322 and 0323 identify a weighing by
--     its kind, so a second dispensed container stored as kind CONTAINER_WEIGHING_2, its container left out, escaped the
--     net, label and total checks: the T2 verification).
--
-- What changed:
--   * recipe.block_data_schema: every block version's data schemas as the block registry declares them (blocks/generic
--     GENERIC_BLOCK_VERSIONS: the entry kinds and the start data; descriptions left out), insert-only and audited, its
--     rows attributed to the software release; the application reads it and writes nothing. A test compares
--     it with the registry member for member (packages/recipe-core/test/execution/entry-data-sql.test.ts, round 6), so
--     a block version added in TypeScript without its rows here fails CI; a new block version adds its rows in a new
--     migration (a version's schemas never change, ADR 0010). It is also the table of which block records which entry
--     kind that 0330 and decision F12.3 left to lead TODO T2.
--   * recipe.block_schema_problem: the engine's validateSchema in SQL, the first problem in the engine's words; the same
--     test compares it with the TypeScript over every entry of the engine's own runs and a corpus of forged values.
--   * recipe.entry_schema_problem and trigger zze_execution_entry_schema (after update of recipe.execution_state; every
--     row that adds an entry, and every accepted RECORD_ENTRY or START_STEP; EBMR-EXE-126, the code of 0300, 0313, 0317,
--     0328 and 0330 for what a row's state records): an accepted RECORD_ENTRY's entry (without its kind) meets the
--     schema of its kind in the block version of the command's step, which must record that kind; an accepted
--     START_STEP's start data, when it carries any, meets that block's start-data schema, which it must have; every
--     entry a row adds is of a kind its step's block records (START_DATA where it has start data), and every member its
--     data holds under a member of that schema meets it (start data in full). The data a block builds from the command
--     is bound to the command member for member (0313, 0330), so the stored data meets the schema as well.
--   * A refused row records what was sent and refused, so it is not held to the schema (the API contract lets through
--     values the engine then refuses for its schema, such as a check id in lower case, and the record keeps that
--     refusal), but its entry or start data never holds a member that no block version declares for that kind of
--     entry or for start data, at any depth (recipe.block_schema_unknown_member), and is never of a kind no block
--     version records: a real identifier cannot sit unread in a refused row's command (DI-05; tablets 0370 reads the
--     members an entry names). Decision F12.4.
--
-- Correction of 0323's header and of decision T2.3, stated here for the same reason: 0323 said that, every stored
-- weighing counting into a quantity its phase records, 0322's total covers every weighing of the step. 0321, 0322 and
-- 0323 identify a weighing by its entry kind, and nothing required a new entry's kind to be one its step's block
-- records, so a weighing stored under another kind escaped all three. Since this migration it cannot be stored.
--
-- Still not decided by the database, stated so it is not over-read (decision F12.3, corrected): whether a block raises
-- the exception an entry calls for and its words, a source addition's share of the batch size (G24-TOO-MUCH), a
-- transfer's two persons (checked at the PERFORMED signature) and the configuration of a block in an imported test
-- package (checked against the block's configuration schema by the server and the engine when the batch is defined,
-- ENG-DEF-CONFIG; recipe.import_test_package recomputes the hashes only). They stay with the release gate's replay
-- (decision REPLAY-GATE.1), which cannot define a batch whose configuration the pinned engine refuses.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- DI-30 (F12, round-5 verification): the data schemas of every block version (blocks/schema.ts FieldSchema as JSON:
-- type, enum, pattern (a JavaScript regular expression without flags, read the same by PostgreSQL: the test compares
-- them), min, minExclusive, max, minItems, maxItems, fields, items, values, optional; descriptions left out). part
-- 'ENTRY' is an entry kind's schema, part 'START' the start data a START_STEP may carry (entry kind START_DATA).
create table recipe.block_data_schema (
  block_type     text not null check (block_type ~ '^[A-Z]{1,3}-[0-9]{2,3}$'),
  block_version  text not null check (block_version ~ '^[1-9][0-9]{0,5}$'),
  part           text not null check (part in ('ENTRY', 'START')),
  entry_kind     text not null check (entry_kind ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  schema         jsonb not null check (jsonb_typeof(schema) = 'object' and schema ->> 'type' = 'object'),
  primary key (block_type, block_version, part, entry_kind),
  check ((part = 'START') = (entry_kind = 'START_DATA'))
);
revoke all on recipe.block_data_schema from public;
-- Configuration shipped by migrations: insert-only and audited, its rows attributed to the software release.
select kernel.register_audited_table('recipe.block_data_schema', 'block_data_schema', 'block_type', true);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0332_entry_block_schema)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the data schemas of the block versions of this release, which every entry is checked against (DI-30, DI-05)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('G-03', '1', 'ENTRY', 'ACKNOWLEDGE', '{"type": "object", "fields": {
     "mode": {"type": "string", "enum": ["READ", "CONFIRM_PERFORMED"]},
     "sopVersion": {"type": "string", "optional": true}}}'),
  ('G-05', '1', 'ENTRY', 'ATTACHMENT', '{"type": "object", "fields": {
     "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
     "mediaType": {"type": "string"},
     "description": {"type": "string"},
     "paperOriginal": {"type": "boolean", "optional": true}}}'),
  ('G-07', '1', 'ENTRY', 'CONTAINER_WEIGHING', '{"type": "object", "fields": {
     "item": {"type": "string"},
     "bomLine": {"type": "string"},
     "container": {"type": "string"},
     "lot": {"type": "object", "fields": {
       "id": {"type": "string"},
       "material": {"type": "string"},
       "status": {"type": "string", "enum": ["RELEASED", "QUARANTINE", "ON_TEST", "REJECTED", "ON_HOLD", "RECALLED", "RETURNED", "EXPIRED"]},
       "expiresAtUs": {"type": "string", "pattern": "^[0-9]{1,20}$", "optional": true},
       "retestAtUs": {"type": "string", "pattern": "^[0-9]{1,20}$", "optional": true},
       "identityTested": {"type": "boolean", "optional": true}}},
     "gross": {"type": "decimal"},
     "tare": {"type": "decimal"},
     "unit": {"type": "string"},
     "balance": {"type": "string"},
     "source": {"type": "string", "enum": ["DEVICE", "MANUAL"]}}}'),
  ('G-08', '1', 'ENTRY', 'CHARGE_CONTAINER', '{"type": "object", "fields": {
     "container": {"type": "string"},
     "scannedBatch": {"type": "string"}}}'),
  ('G-08', '1', 'ENTRY', 'CHARGE_LOT', '{"type": "object", "fields": {
     "bomLine": {"type": "string"},
     "container": {"type": "string"},
     "lot": {"type": "object", "fields": {
       "id": {"type": "string"},
       "material": {"type": "string"},
       "status": {"type": "string", "enum": ["RELEASED", "QUARANTINE", "ON_TEST", "REJECTED", "ON_HOLD", "RECALLED", "RETURNED", "EXPIRED"]},
       "expiresAtUs": {"type": "string", "pattern": "^[0-9]{1,20}$", "optional": true},
       "retestAtUs": {"type": "string", "pattern": "^[0-9]{1,20}$", "optional": true},
       "identityTested": {"type": "boolean", "optional": true}}},
     "quantity": {"type": "object", "optional": true, "fields": {
       "value": {"type": "decimal"},
       "unit": {"type": "string"}}}}}'),
  ('G-22', '1', 'ENTRY', 'OUTPUT_CONTAINER', '{"type": "object", "fields": {
     "intermediate": {"type": "string"},
     "container": {"type": "string", "optional": true},
     "gross": {"type": "decimal"},
     "tare": {"type": "decimal"},
     "unit": {"type": "string"},
     "balance": {"type": "string"},
     "source": {"type": "string", "enum": ["DEVICE", "MANUAL"]}}}'),
  ('G-23', '1', 'ENTRY', 'DISPOSAL', '{"type": "object", "fields": {
     "category": {"type": "string", "enum": ["RETURN_TO_STORES", "REJECT_CONTAINER", "WASTE", "DESTRUCTION"]},
     "material": {"type": "string"},
     "batchCoded": {"type": "boolean", "optional": true},
     "quantity": {"type": "object", "fields": {
       "value": {"type": "decimal"},
       "unit": {"type": "string"}}},
     "container": {"type": "string", "optional": true},
     "method": {"type": "string", "optional": true}}}'),
  ('G-09', '1', 'ENTRY', 'EQUIPMENT_STATUS', '{"type": "object", "fields": {
     "equipmentRef": {"type": "string"},
     "labelId": {"type": "string"},
     "answers": {"type": "array", "items": {"type": "object", "fields": {"id": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,39}$"}, "answer": {"type": "string", "enum": ["YES", "NO"]}}}, "minItems": 1, "maxItems": 20}}}'),
  ('G-10', '1', 'ENTRY', 'CLEARANCE_CHECK', '{"type": "object", "fields": {
     "answers": {"type": "array", "items": {"type": "object", "fields": {"id": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,39}$"}, "answer": {"type": "string", "enum": ["CONFIRMED", "NOT_CONFIRMED", "NOT_APPLICABLE"]}}}, "minItems": 1, "maxItems": 40}}}'),
  ('G-10', '1', 'ENTRY', 'PREVIOUS_BATCH', '{"type": "object", "fields": {
     "product": {"type": "string"},
     "batchNumber": {"type": "string"}}}'),
  ('G-12', '1', 'ENTRY', 'SAMPLE', '{"type": "object", "fields": {
     "point": {"type": "string"},
     "purpose": {"type": "string"},
     "units": {"type": "integer", "min": 1, "max": 100000},
     "container": {"type": "string", "optional": true}}}'),
  ('G-15', '1', 'ENTRY', 'TRANSFER_ISSUED', '{"type": "object", "fields": {
     "material": {"type": "string"},
     "quantity": {"type": "object", "optional": true, "fields": {
       "value": {"type": "decimal"},
       "unit": {"type": "string"}}}}}'),
  ('G-15', '1', 'ENTRY', 'TRANSFER_RECEIVED', '{"type": "object", "fields": {
     "material": {"type": "string"}}}'),
  ('G-24', '1', 'START', 'START_DATA', '{"type": "object", "fields": {
     "investigationRef": {"type": "string"},
     "riskEvaluationRef": {"type": "string"},
     "authorisationRef": {"type": "string"},
     "authorisedBy": {"type": "string"}}}'),
  ('G-24', '1', 'ENTRY', 'SOURCE_ADDITION', '{"type": "object", "fields": {
     "sourceBatch": {"type": "string"},
     "productCode": {"type": "string"},
     "quantity": {"type": "object", "fields": {
       "value": {"type": "decimal"},
       "unit": {"type": "string"}}},
     "manufacturedAtUs": {"type": "string", "pattern": "^[0-9]{1,20}$"},
     "containsRecovered": {"type": "boolean", "optional": true}}}');

select kernel.set_actor_context(null);

-- The app and sandbox roles read it, as the other block tables (0200, 0270); they never write.
grant select on recipe.block_data_schema to ebmr_app;

-- DI-30 (F12, round-5 verification): the first problem of value p_value against schema p_schema (a row's schema or one
-- of its members), at path p_path, in the engine's words (blocks/schema.ts validateSchema: "<path> <message>"); NULL
-- when it meets the schema. A schema of a type this function does not read fails closed.
create function recipe.block_schema_problem(p_schema jsonb, p_value jsonb, p_path text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind    text := jsonb_typeof(p_value);
  v_text    text;
  v_num     numeric;
  v_problem text;
  k         text;
  v         jsonb;
  n         bigint;
begin
  case p_schema ->> 'type'
    when 'string' then
      if v_kind is distinct from 'string' or (p_value #>> '{}') = '' then
        return p_path || ' must be a non-empty text';
      end if;
      if jsonb_typeof(p_schema -> 'enum') = 'array' and not ((p_schema -> 'enum') @> jsonb_build_array(p_value)) then
        return p_path || ' must be one of ' || (select string_agg(x.e #>> '{}', ', ' order by x.i) from jsonb_array_elements(p_schema -> 'enum') with ordinality x (e, i));
      end if;
      if jsonb_typeof(p_schema -> 'pattern') = 'string' and not ((p_value #>> '{}') ~ (p_schema ->> 'pattern')) then
        return p_path || ' has an invalid format';
      end if;
    when 'decimal' then
      -- flow/decimal.ts isDecimalLiteral: optional minus, no exponent, no leading zeros; never a negative zero.
      v_text := p_value #>> '{}';
      if v_kind is distinct from 'string' or v_text !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' or v_text ~ '^-0(\.0+)?$' then
        return p_path || ' must be a decimal written as text (e.g. "0.5"), never a number';
      end if;
      if p_schema ? 'min' and (v_text::numeric < (p_schema ->> 'min')::numeric
                               or (v_text::numeric = (p_schema ->> 'min')::numeric and (p_schema -> 'minExclusive') = 'true'::jsonb)) then
        return p_path || ' must be ' || case when (p_schema -> 'minExclusive') = 'true'::jsonb then 'greater than ' else 'at least ' end || (p_schema ->> 'min');
      end if;
    when 'integer' then
      -- A JavaScript safe integer (Number.isSafeInteger of the number the JSON holds).
      if v_kind = 'number' then
        v_num := (p_value #>> '{}')::numeric;
      end if;
      if v_kind is distinct from 'number' or v_num <> trunc(v_num) or abs(v_num) > 9007199254740991 then
        return p_path || ' must be a whole number';
      end if;
      if p_schema ? 'min' and v_num < (p_schema ->> 'min')::numeric then
        return p_path || ' must be at least ' || (p_schema ->> 'min');
      end if;
      if p_schema ? 'max' and v_num > (p_schema ->> 'max')::numeric then
        return p_path || ' must be at most ' || (p_schema ->> 'max');
      end if;
    when 'boolean' then
      if v_kind is distinct from 'boolean' then
        return p_path || ' must be true or false';
      end if;
    when 'object' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      select min(x) into k from jsonb_object_keys(p_value) x where not coalesce((p_schema -> 'fields') ? x, false);
      if k is not null then
        return p_path || '.' || k || ' is not a field of this block (unknown fields are refused)';
      end if;
      for k, v in select f.key, f.value from jsonb_each(case when jsonb_typeof(p_schema -> 'fields') = 'object' then p_schema -> 'fields' else '{}'::jsonb end) f order by f.key loop
        if not (p_value ? k) then
          if (v -> 'optional') is distinct from 'true'::jsonb then
            return p_path || '.' || k || ' is required';
          end if;
        else
          v_problem := recipe.block_schema_problem(v, p_value -> k, p_path || '.' || k);
          if v_problem is not null then
            return v_problem;
          end if;
        end if;
      end loop;
    when 'array' then
      if v_kind is distinct from 'array' then
        return p_path || ' must be a list';
      end if;
      if p_schema ? 'minItems' and jsonb_array_length(p_value) < (p_schema ->> 'minItems')::numeric then
        return p_path || ' needs at least ' || (p_schema ->> 'minItems') || ' items';
      end if;
      if p_schema ? 'maxItems' and jsonb_array_length(p_value) > (p_schema ->> 'maxItems')::numeric then
        return p_path || ' allows at most ' || (p_schema ->> 'maxItems') || ' items';
      end if;
      for v, n in select a.v, a.i from jsonb_array_elements(p_value) with ordinality a (v, i) order by a.i loop
        v_problem := recipe.block_schema_problem(p_schema -> 'items', v, p_path || '[' || (n - 1) || ']');
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    when 'record' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      for k, v in select f.key, f.value from jsonb_each(p_value) f order by f.key loop
        v_problem := recipe.block_schema_problem(p_schema -> 'values', v, p_path || '.' || k);
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    else
      return p_path || ' has a schema of a type the database does not read (' || coalesce(p_schema ->> 'type', 'none') || ')';
  end case;
  return null;
end
$$;

-- The schema of part p_part (ENTRY, START) and entry kind p_kind of block p_block ({type, version} of an MBR node);
-- NULL when that block version records no such kind (or the node names no block).
create function recipe.block_data_schema_of(p_block jsonb, p_part text, p_kind text) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select s.schema from recipe.block_data_schema s
   where s.block_type = p_block ->> 'type' and s.block_version = p_block ->> 'version' and s.part = p_part and s.entry_kind = p_kind
$$;

-- DI-05 (F12, round-5 verification): the first member of p_value that schema p_schema does not declare, at any depth (an
-- object's member outside its fields, and inside the members, list items and map values it declares), in the engine's
-- words; NULL when there is none. Neither types nor values are read: this is what a refused row is held to (header).
create function recipe.block_schema_unknown_member(p_schema jsonb, p_value jsonb, p_path text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
  k         text;
  v         jsonb;
  n         bigint;
begin
  if p_schema ->> 'type' = 'object' and jsonb_typeof(p_value) = 'object' then
    select min(x) into k from jsonb_object_keys(p_value) x where not coalesce((p_schema -> 'fields') ? x, false);
    if k is not null then
      return p_path || '.' || k || ' is not a field of this block (unknown fields are refused)';
    end if;
    for k, v in select f.key, f.value from jsonb_each(p_value) f order by f.key loop
      v_problem := recipe.block_schema_unknown_member(p_schema -> 'fields' -> k, v, p_path || '.' || k);
      if v_problem is not null then
        return v_problem;
      end if;
    end loop;
  elsif p_schema ->> 'type' = 'array' and jsonb_typeof(p_value) = 'array' then
    for v, n in select a.v, a.i from jsonb_array_elements(p_value) with ordinality a (v, i) order by a.i loop
      v_problem := recipe.block_schema_unknown_member(p_schema -> 'items', v, p_path || '[' || (n - 1) || ']');
      if v_problem is not null then
        return v_problem;
      end if;
    end loop;
  elsif p_schema ->> 'type' = 'record' and jsonb_typeof(p_value) = 'object' then
    for k, v in select f.key, f.value from jsonb_each(p_value) f order by f.key loop
      v_problem := recipe.block_schema_unknown_member(p_schema -> 'values', v, p_path || '.' || k);
      if v_problem is not null then
        return v_problem;
      end if;
    end loop;
  end if;
  return null;
end
$$;

-- DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47 (F12, round-5 verification): why a row of a batch of MBR content
-- p_content, its state going from p_old to p_new, records an entry or start data that does not meet the data schema of
-- its step's block version or is of a kind that block does not record, or why a refused row holds in its entry or start
-- data a member no block version's schema of that kind declares (header); NULL when none. p_command is the command of a
-- COMMAND row (p_accepted its verdict) and NULL for any other row. The text completes "This <row> ...".
create function recipe.entry_schema_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb, p_accepted boolean) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_type    text := p_command ->> 'type';
  v_step    text;
  v_block   jsonb;
  v_name    text;
  v_kind    text;
  v_entry   jsonb;
  v_schema  jsonb;
  v_problem text;
  k         text;
  e         jsonb;
  d         jsonb;
  f         text;
begin
  -- A refused row keeps what was sent, which the engine refused (its schema included), but never a member that no block
  -- version declares for that kind of entry or for start data.
  if p_accepted is not true and v_type = 'RECORD_ENTRY' then
    v_entry := p_command -> 'entry';
    if jsonb_typeof(v_entry) is distinct from 'object' or jsonb_typeof(v_entry -> 'kind') is distinct from 'string' then
      return format('records at step %s a refused entry that names no kind (ENG-ENTRY-KIND)', coalesce(p_command ->> 'step', '(none)'));
    end if;
    v_kind := v_entry ->> 'kind';
    v_entry := v_entry - 'kind';
  elsif p_accepted is not true and v_type = 'START_STEP' and p_command ? 'blockData' then
    v_kind := 'START_DATA';
    v_entry := p_command -> 'blockData';
  end if;
  if p_accepted is not true and v_kind is not null then
    v_problem := null;
    for v_schema in select s.schema from recipe.block_data_schema s
                     where s.part = case when v_type = 'START_STEP' then 'START' else 'ENTRY' end and s.entry_kind = v_kind
                     order by s.block_type, s.block_version loop
      v_problem := recipe.block_schema_unknown_member(v_schema, v_entry, case when v_type = 'START_STEP' then 'startData' else v_kind end);
      exit when v_problem is null;
    end loop;
    if not found then
      return format('records at step %s %s, which no block version records (ENG-ENTRY-KIND)', coalesce(p_command ->> 'step', '(none)'),
                    case when v_type = 'START_STEP' then 'refused start data' else 'a refused entry of kind ' || v_kind end);
    end if;
    if v_problem is not null then
      return format('records at step %s %s holding a member no block version declares for it: %s (ENG-ENTRY-SCHEMA)', coalesce(p_command ->> 'step', '(none)'),
                    case when v_type = 'START_STEP' then 'refused start data' else 'a refused entry' end, v_problem);
    end if;
  end if;
  -- An accepted command's own entry or start data, as the engine checks it before the block sees it (steps.ts
  -- recordEntry, startStep).
  if p_accepted is true and v_type in ('RECORD_ENTRY', 'START_STEP') then
    v_step := p_command ->> 'step';
    v_block := recipe.step_node(p_content, v_step) -> 'block';
    v_name := coalesce(v_block ->> 'type', '(no block)') || '@' || coalesce(v_block ->> 'version', '?');
    if v_type = 'RECORD_ENTRY' then
      v_entry := p_command -> 'entry';
      if jsonb_typeof(v_entry) is distinct from 'object' or jsonb_typeof(v_entry -> 'kind') is distinct from 'string' then
        return format('records at step %s an entry that names no kind (ENG-ENTRY-KIND)', coalesce(v_step, '(none)'));
      end if;
      v_kind := v_entry ->> 'kind';
      v_schema := recipe.block_data_schema_of(v_block, 'ENTRY', v_kind);
      if v_schema is null then
        return format('records an entry of kind %s at step %s, whose block %s does not record that kind (ENG-ENTRY-KIND)', v_kind, coalesce(v_step, '(none)'), v_name);
      end if;
      v_problem := recipe.block_schema_problem(v_schema, v_entry - 'kind', v_kind);
      if v_problem is not null then
        return format('records at step %s an entry that does not meet the data schema of block %s: %s (ENG-ENTRY-SCHEMA)', v_step, v_name, v_problem);
      end if;
    elsif p_command ? 'blockData' then
      v_schema := recipe.block_data_schema_of(v_block, 'START', 'START_DATA');
      if v_schema is null then
        return format('starts step %s with start data, and its block %s takes none (ENG-ENTRY-SCHEMA)', coalesce(v_step, '(none)'), v_name);
      end if;
      v_problem := recipe.block_schema_problem(v_schema, p_command -> 'blockData', 'startData');
      if v_problem is not null then
        return format('starts step %s with start data that does not meet the start-data schema of block %s: %s (ENG-ENTRY-SCHEMA)', v_step, v_name, v_problem);
      end if;
    end if;
  end if;
  -- Every entry the row adds: of a kind its step's block records, its data meeting that kind's schema.
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by x.key loop
    v_kind := e ->> 'kind';
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_block := recipe.step_node(p_content, v_step) -> 'block';
    v_name := coalesce(v_block ->> 'type', '(no block)') || '@' || coalesce(v_block ->> 'version', '?');
    v_schema := recipe.block_data_schema_of(v_block, case when v_kind = 'START_DATA' then 'START' else 'ENTRY' end, v_kind);
    if v_schema is null then
      return format('stores entry %s (%s) of step %s, a kind its block %s does not record (ENG-ENTRY-KIND)', k, coalesce(v_kind, 'unnamed'), coalesce(e ->> 'stepKey', '(none)'), v_name);
    end if;
    d := e -> 'data';
    if v_kind = 'START_DATA' then
      v_problem := recipe.block_schema_problem(v_schema, d, 'startData');
    elsif jsonb_typeof(d) is distinct from 'object' then
      v_problem := v_kind || ' must be an object';
    else
      v_problem := null;
      for f in select x from jsonb_object_keys(v_schema -> 'fields') x where d ? x order by x loop
        v_problem := recipe.block_schema_problem(v_schema -> 'fields' -> f, d -> f, v_kind || '.' || f);
        exit when v_problem is not null;
      end loop;
    end if;
    if v_problem is not null then
      return format('stores entry %s (%s) of step %s whose data does not meet the data schema of block %s: %s (ENG-ENTRY-SCHEMA)', k, v_kind, e ->> 'stepKey', v_name, v_problem);
    end if;
  end loop;
  return null;
end
$$;

-- DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47 (F12, round-5 verification): an entry and a step's start data
-- meet the data schema of the step's block version and are of a kind it records (header). EBMR-EXE-126. Raises;
-- returns nothing.
create function recipe.execution_entry_schema_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_command jsonb;
  v_content jsonb;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_command := case when r.kind = 'COMMAND' then r.command end;
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and (v_command ->> 'type') is distinct from 'RECORD_ENTRY' and (v_command ->> 'type') is distinct from 'START_STEP' then
    return null;
  end if;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.entry_schema_problem(v_content, old.state, new.state, v_command, r.accepted is true);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry and a step''s start data meet the data schema of the step''s block version and are of a kind it records, as the engine checks them before the block accepts them (DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zze_execution_entry_schema after update on recipe.execution_state
  for each row execute function recipe.execution_entry_schema_check();

revoke all on function recipe.block_schema_problem(jsonb, jsonb, text), recipe.block_data_schema_of(jsonb, text, text),
                       recipe.block_schema_unknown_member(jsonb, jsonb, text),
                       recipe.entry_schema_problem(jsonb, jsonb, jsonb, jsonb, boolean), recipe.execution_entry_schema_check() from public;

reset role;
