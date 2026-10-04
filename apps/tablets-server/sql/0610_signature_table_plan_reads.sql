-- Tablets edition, module C1: the application role learns from no query plan, row estimate, row position or planner
-- statistic how many GOVERNANCE-class signing requests and signatures there are, nor of which records (Phase 2 exit
-- follow-up HIGH-WATER, round 5, lane round 1; DI-17, DI-50; Annex 11 and Part 11 limit access to authorised persons;
-- ADR 0012 item 9: the read rules hold when the application's own database credentials are used directly).
--
-- Tablets 0410 and 0430 left the application role SELECT on the signing requests, the signatures and their side tables
-- (esig.challenge, signature, signature_seal, signature_id_register, content_change, signature_invalidation,
-- signing_failure), under row-level security that shows it RECORD-class rows only (the sandbox role followed through
-- sandbox.mirror_application_privileges). Row-level security hides rows, not the planner's view of them:
--  - EXPLAIN ANALYZE reports how many rows the policy removed. Measured as ebmr_app on a fresh GMP copy after one
--    investigation's closure was requested twice and signed once: "Seq Scan on challenge (actual rows=0)", "Rows Removed
--    by Filter: 2". A range on the indexed aggregate reference is leakproof (text comparison), so it runs before the
--    policy and narrows the count to di_investigation records;
--  - plain EXPLAIN gives the planner's row estimate, which it scales by the table's size on disk at planning time;
--  - the row positions (ctid) of the visible rows skip the hidden ones, and so do the ids of content_change and
--    signing_failure, drawn from one identity sequence each;
--  - pg_class's reltuples, relpages and relallvisible, which every role selects out of the box, count every row of a
--    table and of its indexes from the last VACUUM or ANALYZE (exactly, for tables as small as these).
-- Polled, they told when and how many investigations' closures were requested and signed (not about whom: the
-- investigation is not readable). Requesting and signing a disposal approval or a restore approval adds such rows too.
--
-- Correction of tablets 0580's header, of default HW.1 and of the DI-17/DI-50 guard of 0580. 0580 said that, once the
-- authority evaluations were the owner's, a scan of every relation, readable sequence and zero-argument function the
-- role may use found nothing else changing with an investigation's closure but the closure signing's authentication,
-- the sessions' last activity and the audit horizon, and that the authentication tells that someone authenticated to
-- sign a GOVERNANCE-class record, "not which one". The scan compared what the role reads, not what the planner tells it
-- about rows it may not read: until this migration the plans and estimates above told when and how many closures were
-- requested and signed, and narrowed them to investigations. Its test title said the role learns from the evaluations
-- "neither when nor how many investigations were ... closed"; that holds of the evaluations only, and the title now says
-- so. What still tells the application role of a GOVERNANCE-class signing is default HW.1, corrected alongside.
--
-- Now (GMP; the sandbox role follows through sandbox.mirror_application_privileges, which provisioning runs after every
-- migration run):
--  - the application role selects no row or column of the seven tables, so it gets no plan, estimate, row position or
--    id of theirs and pg_stats shows it none of their statistics (the view shows only columns the role may select);
--    row-level security stays on them, as a second line should a grant come back. The server read three things there
--    directly: the signing request a ceremony reads back and signs (features/esig: readChallenge), the signature made for
--    a request whose resend arrives after the signing (challengeUse, review F40) and the correlation of the request a
--    hold-point decision was prepared for (features/execution: challengeCorrelation). It reads them now through
--    tab.session_challenge, which answers only for the session bound to the token the server presents, while that
--    session is active, and only a request made in that session; any other request, token or state reads as no request
--    (the ceremony then refuses as before: EBMR-ESIG-031, "not known here"). Everything else that reads the seven tables
--    is SECURITY DEFINER and runs as the owner (esig.create_challenge, sign, seal_signature, record_signing_failure,
--    signature_state, signature_problems, seal_payload, the 0410 and 0530 readers tab.signatures_of,
--    tab.record_signatures, tab.signature_rows, the engine's and MBR guards); no view reads them and no other
--    application or kernel code of this installation selects them as the application role (the kernel's seal check,
--    esig.verifySignatures, already needed esig.verify_signatures, the owner's since tablets 0450);
--  - no role but the owner and the superusers selects reltuples, relpages and relallvisible of pg_class, in this database
--    (GMP or sandbox: each runs this migration). PUBLIC keeps every other column, so the kernel's and the sandbox
--    mirror's reads of names, kinds, owners and privileges, psql's descriptions and the information schema still
--    answer; a non-superuser login that needs the estimates (an operator's monitoring) is granted them by the operator,
--    never an application role, and the backup role reads them through pg_read_all_data. The owner keeps the whole table
--    because continuity.register_protected_sequence reads a pg_class row whole. This also closes item (3) of default
--    HW.1 (the estimates of the investigation and hold tables). The pg_class part runs as the migration's own role, a
--    superuser (as 0570's), because pg_class belongs to the bootstrap superuser; a template copy keeps the privileges and
--    pg_dump carries them to a restore (PostgreSQL 16, checked on a scratch database).
-- The migration fails if the application role or PUBLIC can still select a column of the seven tables (EBMR-TAB-024),
-- or if PUBLIC, an application role (ebmr_app, ebmr_sandbox), the authentication service (ebmr_authn) or a listener
-- role (ebmr_listener, ebmr_sandbox_listener) can still select a planner estimate of pg_class (EBMR-TAB-025). Applied
-- as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-17, DI-50, DI-38 (HIGH-WATER round 5): the signing request with p_challenge_id, for the session bound to
-- p_token_hash while that session is active, and only when the request was made in that session; with the signature
-- made for it, if any. Any other request, token or session state: no row.
create function tab.session_challenge(p_token_hash text, p_challenge_id uuid)
returns table (challenge_id uuid, aggregate_type text, aggregate_id text, content_version bigint, content_hash text, meaning_code text,
               signer_person uuid, signer_account uuid, session_id uuid, device_id uuid, correlation_id uuid, expires_at timestamptz,
               signature_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select c.id, c.aggregate_type, c.aggregate_id, c.content_version, c.content_hash, c.meaning_code, c.signer_person, c.signer_account,
         c.session_id, c.device_id, c.correlation_id, c.expires_at,
         (select g.id from esig.signature g where g.challenge_id = c.id)
    from esig.challenge c
    cross join (select tab.resolve_session(p_token_hash) as s) r
   where c.id = p_challenge_id
     and r.s ->> 'state' = 'ACTIVE'
     and c.session_id = (r.s ->> 'session_id')::uuid
$$;

revoke all on function tab.session_challenge(text, uuid) from public;
grant execute on function tab.session_challenge(text, uuid) to ebmr_app;

-- DI-17, DI-50 (HIGH-WATER round 5): the signing requests, the signatures and their side tables. A table-level REVOKE
-- also takes any column privilege.
revoke select on esig.challenge, esig.signature, esig.signature_seal, esig.signature_id_register, esig.content_change,
                 esig.signature_invalidation, esig.signing_failure from ebmr_app;

do $$
declare
  v_open text;
begin
  select string_agg(format('%s (%s)', t.name, w.who), ', ' order by t.name, w.who) into v_open
    from unnest(array['esig.challenge', 'esig.signature', 'esig.signature_seal', 'esig.signature_id_register', 'esig.content_change',
                      'esig.signature_invalidation', 'esig.signing_failure']) t (name)
   cross join (values ('ebmr_app'), ('public')) w (who)
   where pg_catalog.has_any_column_privilege(w.who, t.name, 'SELECT');
  if v_open is not null then
    raise exception using errcode = 'P0001',
      message = format('The signing requests and signatures are still selectable by %s (DI-17, DI-50). [EBMR-TAB-024]', v_open);
  end if;
end
$$;

reset role;

-- DI-17, DI-50 (HIGH-WATER round 5): the planner's estimates in pg_class, from PUBLIC; every other column stays PUBLIC's.
revoke select on pg_catalog.pg_class from public;

do $$
declare
  v_columns text;
begin
  select string_agg(pg_catalog.quote_ident(a.attname), ', ' order by a.attnum) into v_columns
    from pg_catalog.pg_attribute a
   where a.attrelid = 'pg_catalog.pg_class'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('reltuples', 'relpages', 'relallvisible');
  execute format('grant select (%s) on pg_catalog.pg_class to public', v_columns);
end
$$;

grant select on pg_catalog.pg_class to ebmr_owner;

do $$
declare
  v_open text;
begin
  select string_agg(w.who || '.' || c.col, ', ' order by w.who, c.col) into v_open
    from (values ('reltuples'), ('relpages'), ('relallvisible')) c (col)
   cross join (select 'public'::text as who
               union all
               select r.rolname::text from pg_catalog.pg_roles r
                where r.rolname in ('ebmr_app', 'ebmr_sandbox', 'ebmr_authn', 'ebmr_listener', 'ebmr_sandbox_listener')) w
   where pg_catalog.has_column_privilege(w.who, 'pg_catalog.pg_class', c.col, 'SELECT');
  if v_open is not null then
    raise exception using errcode = 'P0001',
      message = format('The planner estimates of pg_class are still selectable by %s. Run this migration as a superuser (DI-17, DI-50). [EBMR-TAB-025]', v_open);
  end if;
end
$$;
