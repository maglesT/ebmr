/**
 * Audit-trail verification (INV-08, DI-23). The database recomputes every hash from the stored payload,
 * so verification does not depend on re-implementing the canonical form in TypeScript.
 */
import type pg from 'pg';

export interface ChainProblem {
  chainKey: string;
  seq: number;
  problem: string;
}

export async function verifyChain(db: pg.Pool | pg.PoolClient, chainKey: string, fromSeq = 1): Promise<ChainProblem[]> {
  const { rows } = await db.query<{ seq: string; problem: string }>('select seq, problem from kernel.verify_chain($1, $2)', [chainKey, fromSeq]);
  return rows.map((r) => ({ chainKey, seq: Number(r.seq), problem: r.problem }));
}

/**
 * Every problem of every chain. Chains are enumerated from the events as well as from the chain heads,
 * so deleting a chain's head row cannot take its events out of the verification.
 */
export async function verifyAllChains(db: pg.Pool | pg.PoolClient): Promise<ChainProblem[]> {
  const { rows } = await db.query<{ chain_key: string; seq: string; problem: string }>('select chain_key, seq, problem from kernel.verify_all_chains()');
  return rows.map((r) => ({ chainKey: r.chain_key, seq: Number(r.seq), problem: r.problem }));
}

export interface VerificationRun {
  runId: number;
  chainsChecked: number;
  problems: ChainProblem[];
  /** CRITICAL when any chain does not verify (the DI-23 alarm), otherwise null. */
  alarm: 'CRITICAL' | null;
}

/**
 * The scheduled verification job (DI-23): verifies every chain, keeps the run with every problem it
 * found in kernel.audit_verification_run and, when a chain does not verify, raises the critical
 * integrity alarm (the run row, and a notification on channel ebmr_integrity_alarm) naming each entry.
 */
export async function runChainVerification(db: pg.Pool | pg.PoolClient): Promise<VerificationRun> {
  const { rows: ran } = await db.query<{ id: string }>('select kernel.run_chain_verification() as id');
  const { rows } = await db.query<{ id: string; chains_checked: number; problems: { chain_key: string; seq: number; problem: string }[]; alarm_severity: 'CRITICAL' | null }>(
    'select r.id, r.chains_checked, r.problems, r.alarm_severity from kernel.audit_verification_run r where r.id = $1',
    [ran[0]?.id],
  );
  const run = rows[0];
  if (!run) throw new Error('kernel.run_chain_verification recorded no run');
  return {
    runId: Number(run.id),
    chainsChecked: run.chains_checked,
    problems: run.problems.map((p) => ({ chainKey: p.chain_key, seq: Number(p.seq), problem: p.problem })),
    alarm: run.alarm_severity,
  };
}

export async function verifyAnchor(db: pg.Pool | pg.PoolClient, anchorId: number): Promise<string[]> {
  const { rows } = await db.query<{ problem: string }>('select problem from kernel.verify_anchor($1)', [anchorId]);
  return rows.map((r) => r.problem);
}
