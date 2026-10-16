/**
 * Test world for the reporting views and the change-impact query (Phase 6 slice 6g; recipe-core 1070, 1071).
 *
 * Fixtures, not proofs: MBR versions and their state, formula pins, batch pins, authorisation cells, execution states and
 * completion events, review acts, register exceptions, equipment uses, alarms, deviations, containers, receipts and
 * rule-table site values are written by the superuser with triggers off (GenealogyWorld.fixture), because each act and
 * its guard are proven where the act is built (Phases 2 to 6); the views and the query only read the rows they leave.
 */
import { randomUUID } from 'node:crypto';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import { GenealogyWorld, unique, type Batch, type Lot } from '../genealogy/world.ts';

const HASH = '0'.repeat(64);

export class ReportWorld {
  private constructor(readonly g: GenealogyWorld) {}

  static async create(db: TestDatabase): Promise<ReportWorld> {
    return new ReportWorld(await GenealogyWorld.create(db));
  }

  get db(): TestDatabase {
    return this.g.db;
  }

  /** An MBR version of a new family in `state`, with an optional review due date (fixture). */
  async version(state: 'APPROVED' | 'RETIRED' | 'DRAFT', reviewDue: string | null = null, productCode = 'GEN-500'): Promise<{ id: string; family: string; label: string }> {
    const id = randomUUID();
    const family = unique('FAM-');
    const who = randomUUID();
    await this.g.fixture(
      `with f as (insert into recipe.mbr_family (code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
                  values ($2, 'Report family', 'tablets', 'PROCESSING', $5, 'Report tablets', '500 mg', $2, '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $3, $3) returning id)
       insert into recipe.mbr_version (id, family_id, version_number, author_person, author_account, effective_from, review_due)
       select $1, f.id, 1, $3, $3, '2026-01-01T00:00:00Z', $4::date from f`,
      [id, family, who, reviewDue, productCode],
    );
    await this.g.fixture(
      `insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('mbr_version', $1, 'MBR_VERSION', 1, $2, 1)`,
      [id, state],
    );
    return { id, family, label: `MBR-${family}-v1` };
  }

  /** The version's formula, with one line per material code (fixture). */
  async formula(versionId: string, materials: string[]): Promise<void> {
    const formulaVersion = randomUUID();
    const who = randomUUID();
    await this.g.fixture(
      `with f as (insert into formulary.formula (product_code, strength, batch_size_units, created_by_person, created_by_account, correlation_id)
                  values ($2, '500 mg', 100000, $3, $3, $3) returning id),
            v as (insert into formulary.formula_version (id, formula_id, version_number, change_reason, authored_by_person, authored_by_account, correlation_id)
                  select $1, f.id, 1, 'fixture', $3, $3, $3 from f returning id)
       insert into formulary.mbr_formula_pin (mbr_version_id, formula_version_id, pinned_by_person, pinned_by_account, correlation_id)
       select $4, v.id, $3, $3, $3 from v`,
      [formulaVersion, unique('P'), who, versionId],
    );
    for (const [i, m] of materials.entries()) {
      await this.g.fixture(
        `insert into formulary.formula_line (version_id, line_id, ordinal, material_code, material_name, role, basis, quantity, potency_adjusted, compensating, batch_quantity_kg)
         values ($1, $2, $3, $4, 'Material ' || $4, 'EXCIPIENT', 'PER_BATCH', 1, false, false, 1)`,
        [formulaVersion, `L${i + 1}`, i + 1, m],
      );
    }
  }

  /** A CURRENT authorisation cell of the version in `market` (fixture). */
  async authorise(versionId: string, market: string): Promise<void> {
    await this.g.fixture(
      `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
       select gen_random_uuid(), v.family_id, v.id, v.version_number, $2, 'SITE-1', 'LINE-1', 'BS-1', 'CURRENT', 'CURRENT', '2026-01-01T00:00:00Z' from recipe.mbr_version v where v.id = $1`,
      [versionId, market],
    );
  }

  /** A batch pinned to `versionId` (its stub batch's pin; fixture). */
  async batch(n: string, versionId: string | null = null, parent?: Batch): Promise<Batch> {
    const b = await this.g.batch(n, 'GEN-500', parent);
    if (versionId !== null) {
      await this.g.fixture(
        `insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id)
         select $1, v.family_id, v.id, v.version_number, $3, '{IN}', '{}', '{}', '{}', $2, $2 from recipe.mbr_version v where v.id = $4`,
        [b.id, randomUUID(), HASH, versionId],
      );
    }
    return b;
  }

  /** The batch's execution status (fixture), and for EXECUTION_COMPLETE the completing event at `atUs`. */
  async status(b: Batch, status: string, atUs = '1790000000000000'): Promise<void> {
    await this.g.fixture(
      `insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, '{}', 1, $2, 1, $2, $3)
       on conflict (batch_id) do update set status = excluded.status`,
      [b.id, HASH, status],
    );
    if (status === 'EXECUTION_COMPLETE') {
      const seq = 100 + Math.floor(Math.random() * 1_000_000);
      await this.g.fixture(
        `with c as (insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                                       session_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id)
                    values ($1, $2, 'COMMAND', $3, 'SIGN_OFF_STAGE', '{}', $4, $5, $5, 'HEAD_OF_PRODUCTION', 'UI', $5, 'PERSONAL', $6, true, 1, $4, $4, 1, $4, $4, $5) returning batch_id, seq)
         insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
         select c.batch_id, c.seq, 0, 'BATCH_STATUS_CHANGED', '{"from": "IN_PROGRESS", "to": "EXECUTION_COMPLETE"}' from c`,
        [b.id, seq, randomUUID(), HASH, randomUUID(), atUs],
      );
    }
  }

  /** A review act of the batch (fixture). */
  async reviewAct(b: Batch, act: 'QA_REVIEWED' | 'REOPENED' | 'PRODUCTION_APPROVED', cycle = 1): Promise<void> {
    await this.g.fixture(
      `insert into recipe.batch_review_act (batch_id, cycle, act, signature_id, reason, person_id, account_id, role_code, correlation_id)
       values ($1, $2, $3, gen_random_uuid(), case when $3 = 'REOPENED' then 'reopened for a correction' end, $4, $4, 'QA_REVIEWER', $4)`,
      [b.id, cycle, act, randomUUID()],
    );
  }

  /** A register exception of the batch (fixture). */
  async exception(b: Batch, category: string, type = 'LIMIT_EXCURSION'): Promise<void> {
    const who = randomUUID();
    await this.g.fixture(
      `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, title, raised_at, raised_at_us, raised_by, command_person,
                                              mandatory, qa_only, deviation_required, registration_relevant, release_blocking, raised_record, correlation_id)
       values ($1, $2, 1, $3, $4, 'ACTION', 'fixture exception', now(), 0, 'fixture', $5, false, false, false, false, false, '{}', $5)`,
      [b.id, unique('EX-'), type, category, who],
    );
  }

  /** A piece of equipment (fixture). */
  async equipment(): Promise<{ id: string; code: string }> {
    const id = randomUUID();
    const code = unique('EQ-');
    await this.g.fixture(
      "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, 'Report press', 'CL-PRESS', 'PROCESS', gen_random_uuid())",
      [id, code],
    );
    return { id, code };
  }

  /** The equipment used by the batch (fixture). */
  async used(equipmentId: string, b: Batch): Promise<void> {
    await this.g.fixture(
      `insert into plant.equipment_use (equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by, started_at)
       values ($1, $2, $3, 'GEN-500', now() + interval '1 day', gen_random_uuid(), gen_random_uuid(), now())`,
      [equipmentId, b.id, b.number],
    );
  }

  /** A receipt record naming the manufacturer of a lot (fixture), and the manufacturer approved for the material. */
  async receipt(l: Lot, manufacturer: string, material: string): Promise<void> {
    const who = randomUUID();
    await this.g.fixture(
      `insert into site.lot_receipt (lot_id, site_code, delivery_id, supplier_code, supplier_lot, manufacturer_code, containers, received_value, received_unit,
                                     manufacturer_approved, source, recorded_by_person, recorded_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'SUP-1', $2, $3, 1, '100', 'kg', true, 'MANUAL', $4, $4, $4)`,
      [l.id, unique('D'), manufacturer, who],
    );
    await this.g.fixture(
      `with a as (insert into site.approved_manufacturer (site_code, material_code, manufacturer_code, manufacturer_name, basis, proposed_by_person, proposed_by_account)
                  values ('SITE-1', $1, $2, 'Maker ' || $2, 'qualified by audit and three batches', $3, $3) returning id)
       insert into site.approved_manufacturer_approval (approved_manufacturer_id, signature_id, approved_by_person, approved_by_account) select a.id, gen_random_uuid(), $3, $3 from a`,
      [material, manufacturer, who],
    );
  }

  /** A specification of the material (fixture). */
  async specification(material: string): Promise<string> {
    const id = randomUUID();
    await this.g.fixture(
      `insert into site.specification (id, site_code, material_code, version, title, monograph_reference, drafted_by_person, drafted_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 1, 'Spec ' || $2, 'IP 2022', $3, $3, $3)`,
      [id, material, randomUUID()],
    );
    return id;
  }

  /** A rule-table site value with its markets (fixture; the table version need not exist with triggers off). */
  async siteValue(key: string, markets: string[]): Promise<void> {
    await this.g.fixture(
      `insert into market.site_value (site_id, key, value, unit, effective_from, table_version_id, market_set, predicates, resolution, outcome, recorded_by)
       values (gen_random_uuid(), $1, '"5"', 'percent', '2026-01-01', gen_random_uuid(), $2, '{}', '{}', 'TIGHTER', gen_random_uuid())`,
      [key, markets],
    );
  }
}
