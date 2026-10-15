/**
 * The MBR designer for a hazardous product (Phase 6 slice 6f; IN-27, Schedule M Part I on hazardous substances
 * (cytotoxic, hormone and steroid products: dedicated and contained facilities, protective equipment and decontamination;
 * paraphrased)).
 *
 * When QA has classed the product (plant.product_hazard, recipe-core 0890 and 0912: the approved class and any class
 * recorded after it, pending approval, so a pending upgrade already counts), a new MBR made from a template:
 *   - gets, in every stage, a first operation "Protective equipment" (G-03, the PPE SOP read and confirmed before the
 *     stage's work) and an operation "Decontamination and de-gowning" (G-10) at the end of the stage's processing (just
 *     before the operation computing its yield, which closes the stage), each performed and checked by a second person
 *     (significant steps) and pinning its SOP from the reference documents (DI-10);
 *   - offers only contained areas: every stage's rooms are the rooms and lines dedicated and contained for every class
 *     of the product with a second QA person's approval (plant.area_dedicated); the template's rooms that are such stay,
 *     the others are replaced; with none, the family is not created (DESIGNER_NO_CONTAINED_AREA).
 * The issue gate (recipe-core 0891) still refuses a batch on any other line or room, whatever the MBR says.
 */
import type pg from 'pg';
import { flow } from '@ebmr/recipe-core/pure';
import { DEMO_REFERENCE_DOCUMENTS, referenceContent, referenceHash } from './reference-catalogue.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;

export const PPE_SOP = 'SOP-HAZ-PPE';
export const DECON_SOP = 'SOP-HAZ-DECON';

export interface HazardContext {
  /** The product's hazard classes now (empty: no hazard). */
  classes: string[];
  /** The rooms and lines dedicated and contained for every one of them. */
  containedAreas: string[];
}

/** The product's hazard classes and the areas contained for all of them. */
export async function hazardContext(db: Db, productCode: string): Promise<HazardContext> {
  const { rows } = await db.query<{ classes: string[] }>('select plant.product_hazard_classes($1) as classes', [productCode]);
  const classes = rows[0]?.classes ?? [];
  if (classes.length === 0) return { classes, containedAreas: [] };
  const areas = await db.query<{ code: string }>(
    `select a.code from plant.area a
      where (select bool_and(plant.area_dedicated(a.code, c)) from unnest($1::text[]) c)
      order by a.code collate "C"`,
    [classes],
  );
  return { classes, containedAreas: areas.rows.map((r) => r.code) };
}

export class NoContainedAreaError extends Error {
  constructor(readonly classes: string[]) {
    super(`no room or line is dedicated and contained for ${classes.join(', ')}`);
  }
}

const reference = (code: string): flow.MbrContent['references'][number] => {
  const doc = DEMO_REFERENCE_DOCUMENTS.find((d) => d.code === code);
  if (!doc) throw new Error(`reference document ${code} is not in the catalogue`);
  return { id: doc.code, kind: doc.kind, code: doc.code, version: doc.version, hash: referenceHash(referenceContent(doc)), title: doc.title } as flow.MbrContent['references'][number];
};

type Node = Record<string, unknown> & { kind: string; id: string };

const phase = (id: string, name: string, block: 'G-03' | 'G-10', config: Record<string, unknown>, checked: boolean, riskClass: string): Node => ({
  kind: 'phase',
  id,
  name,
  block: { type: block, version: '1' },
  config,
  records: [],
  computes: [],
  reads: [],
  consumes: [],
  produces: [],
  uses: [],
  equipment: [],
  signatures: checked ? { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } : { perform: { role: 'PRODUCTION_OPERATOR' } },
  significant: true,
  riskClass,
});

const operation = (id: string, name: string, child: Node): Node => ({ kind: 'operation', id, name, body: { kind: 'sequence', id: `${id}-seq`, children: [child] } });

/** Whether a node or any node under it computes one of `ids`. */
function computesAny(n: unknown, ids: ReadonlySet<string>): boolean {
  if (!n || typeof n !== 'object') return false;
  const node = n as { computes?: string[]; children?: unknown[]; body?: unknown };
  if ((node.computes ?? []).some((c) => ids.has(c))) return true;
  return (node.children ?? []).some((c) => computesAny(c, ids)) || computesAny(node.body, ids);
}

/** The content with the PPE and decontamination steps in every stage and only contained areas offered (IN-27). */
export function withContainment(content: flow.MbrContent, hazard: HazardContext): flow.MbrContent {
  if (hazard.classes.length === 0) return content;
  if (hazard.containedAreas.length === 0) throw new NoContainedAreaError(hazard.classes);
  const out = structuredClone(content) as flow.MbrContent & { procedure: { body: Node } };
  const classes = hazard.classes.join(', ');
  const risk = (out.riskScale as { classes: string[] }).classes.at(-1) ?? 'HIGH';
  for (const code of [PPE_SOP, DECON_SOP]) {
    if (!out.references.some((r) => r.id === code)) out.references.push(reference(code));
  }
  const yieldResults = new Set((out.yieldCheckpoints as unknown as { result: string }[]).map((y) => y.result));
  const stages: Node[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as Node & { children?: unknown[]; body?: unknown };
    if (node.kind === 'stage') stages.push(node);
    for (const c of node.children ?? []) walk(c);
    if (node.body) walk(node.body);
  };
  walk(out.procedure.body);
  for (const stage of stages) {
    const key = stage.id.toLowerCase();
    const body = stage['body'] as { kind: string; children?: Node[] };
    if (body.kind !== 'sequence' || !body.children) continue;
    body.children.unshift(
      operation(`O-${stage.id}-PPE`, 'Protective equipment', phase(`p-${key}-ppe`, `Put on the protective equipment for ${classes} handling`, 'G-03', { sop: PPE_SOP, acknowledgement: 'READ' }, true, risk)),
    );
    // The stage's yield closes its processing (GMP-STAGE-YIELD): the decontamination comes just before the operation
    // that computes the yield, or last when the stage has none.
    const decon = operation(`O-${stage.id}-DECON`, 'Decontamination and de-gowning', phase(`p-${key}-decon`, `Decontaminate the room and equipment and de-gown (${classes})`, 'G-10', {}, true, risk));
    const at = body.children.findIndex((op) => computesAny(op, yieldResults));
    if (at < 0) body.children.push(decon);
    else body.children.splice(at, 0, decon);
    const binding = stage['binding'] as { rooms: string[] } | undefined;
    if (binding) {
      const kept = binding.rooms.filter((r) => hazard.containedAreas.includes(r));
      binding.rooms = kept.length > 0 ? kept : [...hazard.containedAreas];
    }
  }
  const check = flow.parseMbr(JSON.parse(JSON.stringify(out)));
  if (!check.ok) throw new Error(`the content with the containment steps does not parse: ${check.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return check.mbr;
}
