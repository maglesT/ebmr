/**
 * MATERIAL references from the material master (Phase 7 slice 7j, R4; decision D-7j-4). A master taken from a formula
 * pins each of its materials. A material the document-management stand-in has no MATERIAL document for is pinned to the
 * version of the material master in effect (site-services 0802, 1530): its reference version names that master version
 * and its hash is over the master's values, so a later master version reads as an unknown pin until the author pins the
 * new one. A registered MATERIAL document always wins (the demo templates' materials are registered documents).
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type pg from 'pg';
import type { flow } from '@ebmr/recipe-core/pure';

export interface MaterialMaster {
  versionId: string;
  code: string;
  name: string;
  kind: string;
  unit: string;
}

/** The reference a master pins for a material master version (id = the material code). */
export function materialReference(m: MaterialMaster): flow.Reference & { hash: string; title: string } {
  return {
    id: m.code,
    kind: 'MATERIAL',
    code: m.code,
    version: `ERP-${m.versionId.slice(0, 8)}`,
    hash: sha256Hex(canonicalJson({ format: 'ebmr.material-master', versionId: m.versionId, code: m.code, name: m.name, kind: m.kind, unit: m.unit })),
    title: m.name,
  };
}

/** The material master versions in effect of `codes` (the known ones). */
export async function materialMasters(db: Pick<pg.Pool, 'query'>, codes: readonly string[]): Promise<MaterialMaster[]> {
  if (codes.length === 0) return [];
  const { rows } = await db.query<{ id: string; code: string; name: string; kind: string; unit: string }>(
    `select distinct on (m.material_code) m.id::text as id, m.material_code as code, m.material_name as name, m.material_kind as kind, m.unit
       from site.erp_master_effect x join site.erp_material m on m.id = x.version_id
      where x.master_kind = 'MATERIAL' and x.master_key = any($1::text[])
      order by m.material_code, x.effective_at desc, x.id desc`,
    [[...codes]],
  );
  return rows.map((r) => ({ versionId: r.id, code: r.code, name: r.name, kind: r.kind, unit: r.unit }));
}
