/**
 * Loads the facts the pure selection model (selection.ts) needs for one family from the database:
 * its batch sizes, every version with its effective date, approval interval and markets, and every
 * authorisation cell. Instants are rendered by the database (recipe.utc_text) in one fixed format.
 */
import type pg from 'pg';
import type { CellFacts, SelectionInput, VersionFacts } from './selection.ts';

export type FamilyFacts = Omit<SelectionInput, 'markets' | 'scope' | 'at'>;

export async function loadSelectionFacts(db: pg.Pool | pg.PoolClient, familyId: string): Promise<FamilyFacts> {
  const fam = await db.query<{ code: string; sizes: string[] }>(
    "select f.code, array(select b ->> 'id' from jsonb_array_elements(f.batch_sizes) b) as sizes from recipe.mbr_family f where f.id = $1",
    [familyId],
  );
  const family = fam.rows[0];
  if (!family) throw new Error(`unknown MBR family ${familyId}`);
  const versions = await db.query<{
    id: string;
    number: number;
    effective_from: string | null;
    approved_from: string | null;
    approved_until: string | null;
    markets: string[] | null;
  }>(
    `select v.id, v.version_number as number, recipe.utc_text(v.effective_from) as effective_from,
            recipe.utc_text(a.approved_from) as approved_from,
            recipe.utc_text((select min(h.recorded_at) from platform.state_history h
                             where h.aggregate_type = 'mbr_version' and h.aggregate_id = v.id and h.to_state in ('RETIRED', 'WITHDRAWN')
                               and a.approved_from is not null and h.recorded_at >= a.approved_from)) as approved_until,
            array(select jsonb_array_elements_text((recipe.current_content(v.id)).content -> 'header' -> 'marketSet')) as markets
       from recipe.mbr_version v
       cross join lateral (select min(h.recorded_at) as approved_from from platform.state_history h
                           where h.aggregate_type = 'mbr_version' and h.aggregate_id = v.id and h.to_state = 'APPROVED') a
      where v.family_id = $1 order by v.version_number`,
    [familyId],
  );
  const cells = await db.query<{
    id: string;
    authorisation_id: string;
    version_id: string;
    market: string;
    site: string;
    line: string;
    batch_size: string;
    kind: 'CURRENT' | 'BRIDGING';
    effective_from: string;
    valid_until: string | null;
    successor_version_id: string | null;
  }>(
    `select id, authorisation_id, version_id, market, site, line, batch_size, kind, recipe.utc_text(effective_from) as effective_from,
            recipe.utc_text(valid_until) as valid_until, successor_version_id
       from recipe.authorisation_cell where family_id = $1 order by recorded_at, id`,
    [familyId],
  );
  return {
    family: family.code,
    batchSizes: family.sizes,
    versions: versions.rows.map(
      (v): VersionFacts => ({ id: v.id, number: v.number, effectiveFrom: v.effective_from, approvedFrom: v.approved_from, approvedUntil: v.approved_until, markets: v.markets ?? [] }),
    ),
    cells: cells.rows.map(
      (c): CellFacts => ({
        id: c.id,
        authorisationId: c.authorisation_id,
        versionId: c.version_id,
        market: c.market,
        site: c.site,
        line: c.line,
        batchSize: c.batch_size,
        kind: c.kind,
        effectiveFrom: c.effective_from,
        validUntil: c.valid_until,
        successorVersionId: c.successor_version_id,
      }),
    ),
  };
}
