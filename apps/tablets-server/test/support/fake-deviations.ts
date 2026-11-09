/**
 * A stand-in for the Deviations product's database (MEDHANTA slice 2): a scratch schema holding the records, and the view
 * Deviations publishes over it, report.deviation_v1, with the published columns (number, status, classification,
 * opened_at, closed_at, product, batch, batch_norm, outcome, read_at, data_as_of; one row per linked batch, and one row
 * with null batch columns for a deviation with no batch), readable by ebmr_app as the platform's link grants it. It
 * does not depend on the Deviations repository. `cut()` revokes the read (the link is cut), `restore()` grants it again.
 */
import { randomUUID } from 'node:crypto';
import { APP_LOGIN, asAdmin, dropDatabase, onServer, urlFor } from '@ebmr/test-kit';

export type FakeDeviationStatus = 'classification' | 'approval' | 'investigation' | 'closure' | 'closed' | 'rejected';

export class FakeDeviations {
  readonly name = `ebmr_dv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  readonly url = urlFor(this.name, APP_LOGIN);

  async create(): Promise<this> {
    await onServer((s) => s.query(`create database ${this.name}`));
    await asAdmin(this.name, async (c) => {
      await c.query('create schema scratch');
      await c.query(`create table scratch.deviation (number text not null, status text not null, classification text, opened_at timestamptz not null default now(),
                       closed_at timestamptz, product text, batch text, outcome text, data_as_of timestamptz not null default now())`);
      await c.query('create schema report');
      await c.query(`create view report.deviation_v1 as
                       select number, status, classification, opened_at, case when status = 'closed' then closed_at end as closed_at, product, batch,
                              upper(regexp_replace(batch, '[^A-Za-z0-9]', '', 'g')) as batch_norm, outcome, now() as read_at, data_as_of
                         from scratch.deviation`);
      await c.query(`grant connect on database ${this.name} to ebmr_app`);
      await c.query('grant usage on schema report to ebmr_app');
      await c.query('grant select on report.deviation_v1 to ebmr_app');
    });
    return this;
  }

  /** Records deviation `number` linked to `batch` (null: no batch), or moves it to `status` (every row of the number). */
  async put(number: string, status: FakeDeviationStatus, batch: string | null = null, classification = 'major'): Promise<void> {
    await asAdmin(this.name, async (c) => {
      const { rowCount } = await c.query('update scratch.deviation set status = $2, closed_at = case when $2 = \'closed\' then now() end, data_as_of = now() where number = $1', [number, status]);
      if (!rowCount) {
        await c.query('insert into scratch.deviation (number, status, classification, product, batch) values ($1, $2, $3, $4, $5)', [number, status, classification, batch ? 'PARACETAMOL-500' : null, batch]);
      }
    });
  }

  async cut(): Promise<void> {
    await asAdmin(this.name, (c) => c.query('revoke select on report.deviation_v1 from ebmr_app'));
  }

  async restore(): Promise<void> {
    await asAdmin(this.name, (c) => c.query('grant select on report.deviation_v1 to ebmr_app'));
  }

  async drop(): Promise<void> {
    await dropDatabase(this.name);
  }
}
