/**
 * Audit-trail verification (INV-08). The database recomputes every hash from the stored payload,
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

export async function verifyAllChains(db: pg.Pool | pg.PoolClient): Promise<ChainProblem[]> {
  const { rows } = await db.query<{ chain_key: string }>('select chain_key from kernel.audit_chain_head order by chain_key');
  const problems: ChainProblem[] = [];
  for (const { chain_key } of rows) problems.push(...(await verifyChain(db, chain_key)));
  return problems;
}

export async function verifyAnchor(db: pg.Pool | pg.PoolClient, anchorId: number): Promise<string[]> {
  const { rows } = await db.query<{ problem: string }>('select problem from kernel.verify_anchor($1)', [anchorId]);
  return rows.map((r) => r.problem);
}
