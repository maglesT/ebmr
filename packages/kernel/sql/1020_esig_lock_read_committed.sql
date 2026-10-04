-- Electronic signatures (B2): the per-record signing lock serialises a signing with every change of its record only in
-- a READ COMMITTED transaction, so it is taken in no other (Phase 2 exit review F37, the round-4 verification of the
-- completeness critic's F37 defect; INV-09, DI-37; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- esig.aggregate_lock (0220) is the transaction lock every signing (esig.sign, 0230) and every change of a signed record
-- (esig.content_changed, 0220, the trigger on every registered signed table; and the recipe proposal functions, recipe
-- 0329) takes before it reads the record: the comment on it says a change can never slip between a signing's hash
-- check and its commit. That holds only when the statements after the lock read what committed before it was granted,
-- which READ COMMITTED gives (one snapshot per statement). Under REPEATABLE READ or SERIALIZABLE the whole transaction
-- reads one snapshot, taken at its first statement, before the wait for the lock:
--   * a signing re-hashes the record as its snapshot saw it, so a change that committed meanwhile (or while the signing
--     waited for the change's lock) goes unseen: the signature is made over content the record no longer has, the change
--     superseded nothing (the signature did not exist yet), and the signature reads CONTENT_MISMATCH, which only
--     esig.verify_signatures reports (the round-4 verification of F37: a QA signing in REPEATABLE READ that waited for
--     another QA user's proposal and then committed; recipe 0329's header and decision F37.1 claimed EBMR-ESIG-012
--     refused it);
--   * a change likewise looks for the signatures to supersede in its snapshot, so a signature committed after that
--     snapshot is left unsuperseded over content the change has just altered (checked on PostgreSQL 16 before this
--     migration: a supervisor's deviation link stored in REPEATABLE READ, and in SERIALIZABLE, after QA1's disposition
--     signature committed, left that signature CONTENT_MISMATCH; apps/tablets-server db-guards-proposal-race.test.ts).
--     Where the change and the signing also write the same audit chain (esig's stub records), the later one already
--     ended in a serialization failure; the execution store audits its content on the batch's chain and its signatures
--     on the record's, so nothing stopped it there.
-- SSI does not help: a SERIALIZABLE transaction detects conflicts only with other SERIALIZABLE transactions, and the
-- signings and changes of the server run in READ COMMITTED (decision X20).
--
-- esig.aggregate_lock (CREATE OR REPLACE; same name, arguments, owner, SECURITY DEFINER, search_path and privileges:
-- private to the owner) now refuses a transaction whose isolation level is not READ COMMITTED (EBMR-ESIG-015) before it
-- takes the lock. So esig.sign, every change of a signed record and the recipe proposals are refused in REPEATABLE READ
-- and SERIALIZABLE transactions; nothing the server does changes (its commands run in READ COMMITTED, the default). A
-- REPEATABLE READ READ ONLY transaction (the true copy, the backup drill) never takes the lock. The architecture's plan
-- to run release and certification in SERIALIZABLE (architecture 5.5) is therefore bound to sign in READ COMMITTED
-- with explicit locks, or to replace this lock with one that holds under its isolation level, when that phase is built
-- (decision F37.2). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- INV-09 (F37, round-4 verification): the transaction lock per signed record; only in READ COMMITTED (header).
create or replace function esig.aggregate_lock(p_aggregate_type text, p_aggregate_id text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-015 a signature, and a change of signed content, are made only in a READ COMMITTED transaction: under %s the transaction reads %s %s as its snapshot saw it, so a signing or a change committed meanwhile by another transaction is not seen, and a signature could cover content the record no longer has (INV-09)',
                       current_setting('transaction_isolation'), coalesce(p_aggregate_type, '(no type)'), coalesce(p_aggregate_id, '(no id)'));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('esig:' || p_aggregate_type || ':' || p_aggregate_id, 0));
end
$$;

reset role;
