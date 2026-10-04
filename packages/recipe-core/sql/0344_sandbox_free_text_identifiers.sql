-- Recipe core, execution store (module C3): nothing a test run records holds a real-format batch, lot or container
-- identifier, in any member or text (Phase 2 exit review F12, closed for the class after nine rounds; DI-05, DI-30,
-- INV-18; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong. Each round of F12 bound the members a verifier had found (tablets 0370, 0380, 0390; recipe-core 0317,
-- 0328, 0330, 0332, 0335 to 0343) and each next verification found another member, bound to nothing, where a writer
-- holding the application's credentials stored the real-format lot number L2409-0017 in a test run's record: the round-9
-- verification stored it as the authoriser of a reprocessing's start data (G-24 authorisedBy) and as the equipment of
-- an equipment status at a step that lists none (EQUIPMENT_STATUS.equipmentRef), both accepted, with an identical
-- replay. Decision F12.5 had also let every member declared as free text (a comment, a reason, a justification, a
-- deviation reference, an answer, a refusal's message, what a refused row was sent) hold such a text. The lists were
-- the defect: a member no list named was read by nothing.
--
-- What changed. Every text the application role can write into a test run's record is read with the identifier rule
-- (kernel 0810, read in text by kernel 1030: sandbox.identifier_words, sandbox.real_identifier_parts), whatever member
-- holds it, by deferred constraint triggers that run at commit, after every other check of the row (so the other
-- guards still give their own refusal first), in an installation that is not GMP (EBMR-EXE-147):
--   * recipe.batch_execution (batch number, hashes, installation, purpose, engine version, policy, issue request, market
--     set, batch size, site, room, zone);
--   * recipe.execution_command (kind, command id and type, command, its hash, role, source, device class, room, refusal,
--     hashes, roles, evidence); not actor_legal_name, which is the person's registered name (kernel 0190 refuses any
--     other, EBMR-IAM-117) under the kernel's PERSON_LABEL rule;
--   * recipe.execution_state (state, hashes, status), recipe.execution_event (type, event), the four content stores (key,
--     aggregate id, content, hash), the two proposal tables (step or exception, aggregate id, proposal),
--     recipe.execution_clock (batch number) and recipe.execution_stage_summary_legacy (aggregate and signature ids);
--   * kernel.audit_event entries on a test run's own chains ('batch:<run>', and the record chains 'batch_step:',
--     'batch_stage:', 'batch_exception:' and 'batch_point:<run>:...' with their 'esig_challenge:' and 'esig_signature:'
--     chains): the reason code and reason text of the actor context, which the kernel copies into every entry, and the
--     message and details of a business entry, which the application role can also append itself
--     (kernel.audit_business_event); and on the chain of a scale reading ('device_reading:<id>'), which a test run's
--     weighing claims, the reason of the actor context (the gateway's own entries there name instrument serials).
-- Every string and every member name of a jsonb value is read, at any depth (a member nested three levels down
-- included), and every text, text[] and jsonb column named above. A word the rule reads as a real batch or lot number
-- (kernel 1030: a word of the identifier alphabet with a letter and a digit that the rule accepts with TEST- in front
-- and refuses as it stands) is refused unless the run's record has it from a bound source:
--   * the run's MBR: a name in the imported package's content, product, family code or version (the approved,
--     hash-bound definition; its own ids are not lot numbers, decision F12.2);
--   * the run's own batch number and location: the site and room the batch was issued in, and the room of the session
--     that writes a row;
--   * a compound of these the engine builds (a sample's id <batch>/<step>/S<n>, a container's <batch>/<intermediate>/
--     <frames>/<n>): every part between '/' one of them, an engine name or a number;
--   * the engine's own names: record ids EX-, EN-, DP-, DV-, HOLD-<n> (0339), the flow graph's edge ids e<n>, block
--     types G-<nn> and block rule codes G<nn>-<WORDS> (0336), control ids of the register (0336), the schema tags of the
--     engine's values (ebmr.expr.evaluation/1) and the member name sha256;
--   * in an audit entry only: a word of the legal name or login of a person of this installation (the kernel writes the
--     signer's or actor's name into its own messages; names are bound to the person register) and the leading
--     characters of one of the run's own hashes (the issue's entry names the package and content by them).
-- A refusal names the table, the column and the JSON path, never the word itself, so the server's answer, a stored
-- answer for a repeated request or the signing-failure log does not copy it. The per-member guards stay: they bind
-- meaning (which lot, which batch, which container, which person), this binds form. What the reading cannot see is
-- kernel 1030's list (an identifier of digits only, one broken by spaces or written in words); decision F12.8.
--
-- Corrections of earlier claims (applied migrations are never edited):
--   * 0342 says the approver's id was "the one person reference of a command bound to nothing"; G-24 start data's
--     authorisedBy was another (bound since recipe-core 0345).
--   * Decision F12.5's default "a member a type declares as free text ... is not read as an identifier" no longer holds
--     in a test run: from here on such a member never holds a word read as a real batch or lot number (F12.8).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05: whether word p_word is a name the engine itself gives (header): a record id, a flow edge id, a sample's number
-- S<n>, a block type or block rule code, a control id of the register, a schema tag of an engine value, the member name
-- sha256.
create function recipe.engine_word(p_word text) returns boolean
language sql immutable strict set search_path = pg_catalog, pg_temp as $$
  select translate(p_word, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
         ~ '^((EX|EN|DP|DV|HOLD)-[0-9]+|E[0-9]+|S[0-9]+|G-[0-9]{2}|G[0-9]{2}(-[A-Z]+)+|(DI|IN|INV|PR|ST)-[0-9]{2}|EBMR(\.[A-Z]+)+/[0-9]+|SHA256)$'
$$;

-- DI-05: the names test batch p_batch's record has from a bound source (header), upper-cased as the identifier rule
-- compares them: every run of letters, digits, '.' and '-' in its MBR (the imported package's content, product, family
-- code and version), its batch number, site and room. Empty for a batch that does not exist.
create function recipe.batch_bound_words(p_batch uuid) returns text[]
language sql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
  select coalesce(array_agg(distinct sandbox.ascii_upper(m[1])), '{}')
    from recipe.batch_execution b
    join recipe.test_package p on p.package_hash = b.package_hash
   cross join lateral regexp_matches(sandbox.escapes_decoded(normalize(jsonb_build_array(p.content, p.product, p.family_code, p.version_number,
                                                                                        b.batch_number, b.site_code, b.room_code)::text, NFKC)),
                                     '([A-Za-z0-9][A-Za-z0-9.-]*)', 'g') m
   where b.id = p_batch
$$;

-- DI-05: whether word p_word is bound (header): an engine name, one of p_bound, or a compound of them the engine builds
-- (a sample, container or sub-lot id: the batch number, MBR ids and numbers joined by '/'), every part between '/'
-- being an engine name, one of p_bound or a number.
create function recipe.bound_word(p_word text, p_bound text[]) returns boolean
language sql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
  select recipe.engine_word(p_word) or sandbox.ascii_upper(p_word) = any(p_bound)
         or (strpos(p_word, '/') > 0
             and not exists (select 1 from unnest(string_to_array(p_word, '/')) x
                              where not (x ~ '^[0-9]+$' or recipe.engine_word(x) or sandbox.ascii_upper(x) = any(p_bound))))
$$;

-- DI-05: the first word of value p_value that the identifier rule reads as a real batch or lot number (kernel 1030) and
-- that is not bound (recipe.bound_word); NULL when there is none.
create function recipe.unbound_real_identifier(p_value jsonb, p_bound text[]) returns text
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  w text;
  p text;
begin
  for w in select x from sandbox.identifier_words(p_value) x order by 1 loop
    continue when recipe.bound_word(w, p_bound);
    for p in select y from sandbox.real_identifier_parts(w) y order by 1 loop
      continue when recipe.bound_word(p, p_bound);
      return p;
    end loop;
  end loop;
  return null;
end
$$;

-- DI-05: where in value p_value word p_word stands: the JSON path of the first string holding it, or of the object one
-- of whose member names holds it (the name itself is not repeated: a refusal never copies the word into a log).
create function recipe.word_path(p_value jsonb, p_word text) returns text
language sql stable set search_path = pg_catalog, sandbox, pg_temp as $$
  with recursive t (path, v, depth) as (
    select '$'::text, p_value, 0
    union all
    select t.path || e.step, e.value, t.depth + 1
      from t
     cross join lateral (
       select '.' || x.key as step, x.value
         from jsonb_each(case when jsonb_typeof(t.v) = 'object' then t.v end) x
       union all
       select '[' || (a.ord - 1) || ']', a.value
         from jsonb_array_elements(case when jsonb_typeof(t.v) = 'array' then t.v end) with ordinality a (value, ord)
     ) e
     where t.depth < 64
  )
  select coalesce(
    (select t.path from t where jsonb_typeof(t.v) = 'string' and position(p_word in sandbox.escapes_decoded(normalize(t.v #>> '{}', NFKC))) > 0 order by length(t.path), t.path limit 1),
    (select t.path || ' (the name of one of its members)' from t cross join lateral jsonb_object_keys(case when jsonb_typeof(t.v) = 'object' then t.v end) k
      where position(p_word in sandbox.escapes_decoded(normalize(k, NFKC))) > 0 order by length(t.path), t.path limit 1),
    '$')
$$;

-- DI-05, DI-30: row trigger of the execution store's tables (header). Arguments: the column holding the batch id, then
-- the columns to read. Outside a GMP installation, refuses a row whose named columns hold a word read as a real batch
-- or lot number that the run's record does not have from a bound source. EBMR-EXE-147. Raises; returns nothing.
create function recipe.execution_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, sandbox, kernel, pg_temp as $$
declare
  v_row   jsonb := to_jsonb(new);
  v_batch uuid;
  v_value jsonb := '{}'::jsonb;
  v_bound text[];
  v_word  text;
  i       integer;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_batch := (v_row ->> tg_argv[0])::uuid;
  for i in 1 .. tg_nargs - 1 loop
    v_value := v_value || jsonb_build_object(tg_argv[i], v_row -> tg_argv[i]);
  end loop;
  -- Most rows hold no word the rule reads as an identifier other than the engine's own names: nothing more to read.
  if not exists (select 1 from sandbox.identifier_words(v_value) w where not recipe.engine_word(w)) then
    return null;
  end if;
  v_bound := recipe.batch_bound_words(v_batch)
             || case when jsonb_typeof(v_row -> 'room_code') = 'string' then array[sandbox.ascii_upper(v_row ->> 'room_code')] else '{}'::text[] end;
  for i in 1 .. tg_nargs - 1 loop
    v_word := recipe.unbound_real_identifier(v_row -> tg_argv[i], v_bound);
    if v_word is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row of test batch %s cannot be recorded: %s holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, whatever member holds it, so a real GMP identifier is never reused (DI-05, DI-30). [EBMR-EXE-147]',
                         tg_table_name, coalesce(v_batch::text, 'unknown'), tg_argv[i], recipe.word_path(v_row -> tg_argv[i], v_word));
    end if;
  end loop;
  return null;
end
$$;

-- DI-05: the test batch whose record audit chain p_chain_key is (header): 'batch:<run>' or a chain of one of its
-- records (batch_step, batch_stage, batch_exception, batch_point, and their esig_challenge and esig_signature chains);
-- NULL for any other chain.
create function recipe.audit_chain_batch(p_chain_key text) returns uuid
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select b.id
    from recipe.batch_execution b
   where b.id::text = substring(p_chain_key from '^(?:batch:|(?:esig_challenge:|esig_signature:)?batch_(?:step|stage|exception|point):)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)')
$$;

-- DI-05: the words an audit entry of test batch p_batch (NULL for a scale reading's chain) has from a bound source
-- besides the run's (header): the words of the legal names and logins of the persons of this installation, and the
-- leading characters of the run's hashes found in p_value.
create function recipe.audit_bound_words(p_batch uuid, p_value jsonb) returns text[]
language sql stable set search_path = pg_catalog, recipe, sandbox, iam, pg_temp as $$
  select coalesce(array_agg(distinct sandbox.ascii_upper(w)), '{}')
    from (select x as w from iam.person p cross join lateral sandbox.identifier_words(p.legal_name) x
          union all
          select x from iam.account a cross join lateral sandbox.identifier_words(a.login_name) x
          union all
          select x from sandbox.identifier_words(p_value) x
           where x ~ '^[0-9a-f]{8,63}$'
             and exists (select 1 from recipe.batch_execution b
                          where b.id = p_batch
                            and (starts_with(b.package_hash, x) or starts_with(b.content_hash, x) or starts_with(b.policy_hash, x)
                                 or starts_with(b.registry_fingerprint, x)))) y
$$;

-- DI-05: an audit entry of a test run's chain names no real batch or lot number in its reason or business message
-- (header). EBMR-EXE-147. Raises; returns nothing.
create function recipe.audit_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, sandbox, kernel, pg_temp as $$
declare
  v_batch uuid;
  v_value jsonb;
  v_bound text[];
  v_word  text;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_batch := recipe.audit_chain_batch(new.chain_key);
  if v_batch is not null then
    v_value := jsonb_build_object('reason_code', new.payload -> 'reason_code', 'reason_text', new.payload -> 'reason_text')
               || case when new.action = 'BUSINESS' then jsonb_build_object('body', new.payload -> 'body') else '{}'::jsonb end;
  elsif new.chain_key like 'device_reading:%' then
    -- A scale reading a test run uses: the reason of the actor context that claims it (the gateway's own business
    -- entries on the chain name instrument serials, which are not lot numbers, and are not read).
    v_value := jsonb_build_object('reason_code', new.payload -> 'reason_code', 'reason_text', new.payload -> 'reason_text');
  else
    return null;
  end if;
  if not exists (select 1 from sandbox.identifier_words(v_value) w where not recipe.engine_word(w)) then
    return null;
  end if;
  v_bound := case when v_batch is not null then recipe.batch_bound_words(v_batch) else '{}'::text[] end || recipe.audit_bound_words(v_batch, v_value);
  v_word := recipe.unbound_real_identifier(v_value, v_bound);
  if v_word is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s entry of audit chain %s%s cannot be recorded: it holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, also in a reason or a business entry of its audit trail (DI-05, DI-30). [EBMR-EXE-147]',
                       lower(new.action), left(new.chain_key, 120), case when v_batch is not null then ' of test batch ' || v_batch else '' end,
                       recipe.word_path(v_value, v_word));
  end if;
  return null;
end
$$;

create constraint trigger zzz_sandbox_free_text after insert on recipe.batch_execution deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('id', 'batch_number', 'package_hash', 'content_hash', 'installation', 'purpose',
    'engine_version', 'registry_fingerprint', 'policy', 'policy_hash', 'issue_request', 'market_set', 'batch_size', 'site_code', 'room_code', 'site_zone');
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_command deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'kind', 'command_id', 'command_type', 'command', 'command_hash',
    'actor_role', 'source', 'device_class', 'room_code', 'refusal', 'state_hash', 'events_hash', 'roles', 'evidence', 'prev_row_hash', 'row_hash');
create constraint trigger zzz_sandbox_free_text after insert or update on recipe.execution_state deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'state', 'state_hash', 'last_row_hash', 'status');
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_event deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'event_type', 'event');
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_step_content deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'aggregate_key', 'aggregate_id', 'content', 'content_hash');
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_stage_content deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'aggregate_key', 'aggregate_id', 'content', 'content_hash');
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_exception_content deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'aggregate_key', 'aggregate_id', 'content', 'content_hash');
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_point_content deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'aggregate_key', 'aggregate_id', 'content', 'content_hash');
create constraint trigger zzz_sandbox_free_text after insert or update on recipe.execution_disposition_proposal deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'exception_id', 'aggregate_id', 'proposal');
create constraint trigger zzz_sandbox_free_text after insert or update on recipe.execution_decision_proposal deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'step_key', 'aggregate_id', 'proposal');
create constraint trigger zzz_sandbox_free_text after insert or update on recipe.execution_clock deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'batch_number');
create constraint trigger zzz_sandbox_free_text after insert or update on recipe.execution_stage_summary_legacy deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'aggregate_id', 'signature_id');
create constraint trigger zzz_sandbox_free_text after insert on kernel.audit_event deferrable initially deferred
  for each row execute function recipe.audit_free_text_check();

revoke all on function recipe.engine_word(text), recipe.batch_bound_words(uuid), recipe.bound_word(text, text[]), recipe.unbound_real_identifier(jsonb, text[]),
                       recipe.word_path(jsonb, text), recipe.execution_free_text_check(), recipe.audit_chain_batch(text),
                       recipe.audit_bound_words(uuid, jsonb), recipe.audit_free_text_check() from public;

reset role;
