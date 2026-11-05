/**
 * Phase B slice 3 (platform-move-plan.md, "Guard facts"; PL-07, PL-08): master data through the platform's versioned
 * views. On the platform build the database refuses a write whose master item has no fact recorded in the writing
 * transaction (md.require_active, SQLSTATE EBM01). The kernel's withCommand then asks this reader: it reads the item
 * through report.<kind>_v1 on its own login (the platform's link, MASTER_DATA_DATABASE_URL), and the command runs again
 * with md.record_fact(...) first, in the same transaction as the write. The browser never supplies the fact.
 *
 * Connection off: when the master read is refused (the link was cut: 42501 or 28000) or the database cannot be reached,
 * the write stops with MASTER_DATA_OFF ("Connection to master data is off. Ask your administrator."). Nothing is served
 * from a copy; records already written still open (they keep their own values, PL-07).
 */
import pg from 'pg';
import type { FactRecorder, FactResolver } from '@ebmr/kernel';
import { refusal } from './http/refusal.ts';

export const MASTER_KINDS = ['product', 'room', 'equipment', 'instrument', 'material'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

/** The master view of each kind (master_data, published by the platform; _v1 only gains columns). */
export const MASTER_VIEWS: Record<MasterKind, string> = {
  product: 'report.product_v1',
  room: 'report.room_v1',
  equipment: 'report.equipment_v1',
  instrument: 'report.instrument_v1',
  material: 'report.material_v1',
};

export interface MasterItem {
  id: string;
  code: string;
  name: string;
  version: number;
  active: boolean;
  /**
   * Capsules edition C2 (lead, 4 November 2026): a product's dosage form as core holds it (report.product_v1
   * `dosage_form`, free text; null when core has none, which means a tablet). Products only.
   */
  dosageForm?: string | null;
}

/** A refused or unreachable master read: the link is cut (42501, 28000) or the database is not there. */
const OFF_STATES = new Set(['42501', '28000', '28P01', '3D000', '57P01', '57P03', '08000', '08001', '08003', '08004', '08006']);

export function masterDataOff() {
  return refusal(503, {
    code: 'MASTER_DATA_OFF',
    kind: 'NOT_SAVED',
    whatHappened: 'Connection to master data is off. Ask your administrator.',
    why: 'This action needs the item from master data, and master data cannot be read now. Nothing was saved.',
    controls: ['PL-08'],
    whatYouCanDo: ['Records already made still open. Try again once the administrator has restored the connection.'],
    whoCanHelp: ['Your administrator'],
  }, true);
}

function isOff(error: unknown): boolean {
  const e = error as { code?: unknown };
  return typeof e.code !== 'string' || OFF_STATES.has(e.code) || e.code.startsWith('08');
}

export class MasterData {
  constructor(private readonly pool: pg.Pool) {}

  static open(url: string): MasterData {
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    pool.on('error', () => undefined);
    return new MasterData(pool);
  }

  /** The item by its master id (an id-mapped item) or else by its code; null: the view has no such item. */
  async read(kind: MasterKind, key: { masterId?: string; code: string }): Promise<MasterItem | null> {
    const view = MASTER_VIEWS[kind];
    const [where, value] = key.masterId ? ['id = $1::uuid', key.masterId] : ['code = $1', key.code];
    try {
      const extra = kind === 'product' ? ', dosage_form as "dosageForm"' : '';
      const { rows } = await this.pool.query<MasterItem>(`select id::text as id, code, name, version, active${extra} from ${view} where ${where}`, [value]);
      return rows[0] ?? null;
    } catch (error) {
      if (isOff(error)) throw masterDataOff();
      throw error;
    }
  }

  /** The kernel's fact resolver: reads the item the database asked for and returns the statement that records it. */
  resolver(): FactResolver {
    return async (detail: string): Promise<FactRecorder> => {
      const need = JSON.parse(detail) as { kind: MasterKind; code: string; masterId?: string };
      if (!MASTER_KINDS.includes(need.kind)) throw new Error(`no master view for kind ${need.kind}`);
      const item = await this.read(need.kind, need.masterId ? { masterId: need.masterId, code: need.code } : { code: need.code });
      return async (client) => {
        await client.query('select md.record_fact($1, $2, $3, $4, $5, $6, $7)', [
          need.kind, need.code, item?.id ?? null, item?.code ?? null, item?.name ?? null, item ? String(item.version) : null, item?.active ?? false,
        ]);
      };
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
