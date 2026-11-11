/**
 * A planned GMP batch fixture for route tests that need a real batch subject (a deviation link, a release checklist):
 * the family, the stub batch and its register allocation, written directly as site-services' QualityWorld.gmpBatch
 * arranges them. Moved here from the MEDHANTA slice 2 test so the kiosk deviation test links to a real batch too.
 */
import { randomUUID } from 'node:crypto';
import type { TestServer } from './harness.ts';

const tag = (): string => randomUUID().slice(0, 6).toUpperCase();

/** A planned GMP batch at SITE-1 with its register allocation (as site-services' QualityWorld.gmpBatch arranges it). */
export async function gmpBatch(server: TestServer): Promise<{ id: string; number: string }> {
  const id = randomUUID();
  const number = `B${tag()}`;
  const who = randomUUID();
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                                 created_by_person, created_by_account)
                  values (gen_random_uuid(), $2, 'Fixture family', 'tablets', 'PROCESSING', 'PARA-500', 'Paracetamol tablets', '500 mg', $2,
                          '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $4, $4) returning id),
            b as (insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
                  select $1, $3, f.id, array['IN'], 'SITE-1', 'LINE-1', 'BS-1', $4, $4 from f returning id),
            a as (insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
                                                            batch_size, batch_size_unit, source, external_reference, allocated_by_person_id,
                                                            allocated_by_account_id, correlation_id)
                  values (gen_random_uuid(), $3, 'SITE-1', 'Asia/Kolkata', 'PARA-500', 'Paracetamol tablets', 'TABLETS', 'PROCESSING', 100, 'kg', 'EXTERNAL', 'fixture', $4, $4, $4) returning id)
       insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
       select b.id, a.id, $3, $4, $4, $4 from b, a`,
      [id, `FAM-${tag()}`, number, who],
    );
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
  return { id, number };
}
