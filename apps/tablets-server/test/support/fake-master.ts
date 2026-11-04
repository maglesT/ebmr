/**
 * A stand-in for the platform's master_data database (Phase B slice 3): its published views as tables with the
 * contract's columns (databsee db/master_data: report.<kind>_v1 with id, code, name, version, active, ...), readable by
 * ebmr_app as the platform's link grants them. `cut()` revokes the read (the link is cut: 42501), `restore()` grants it
 * again.
 */
import { randomUUID } from 'node:crypto';
import { APP_LOGIN, asAdmin, dropDatabase, onServer, urlFor } from '@ebmr/test-kit';

export const MASTER_TABLES = ['product', 'room', 'equipment', 'instrument', 'material'] as const;
export type MasterTable = (typeof MASTER_TABLES)[number];

export class FakeMaster {
  readonly name = `ebmr_md_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  readonly url = urlFor(this.name, APP_LOGIN);

  async create(): Promise<this> {
    await onServer((s) => s.query(`create database ${this.name}`));
    await asAdmin(this.name, async (c) => {
      await c.query('create schema report');
      for (const t of MASTER_TABLES) {
        await c.query(`create table report.${t}_v1 (id uuid primary key default gen_random_uuid(), code text not null unique, name text not null,
                         version int not null default 1, active boolean not null default true, read_at timestamptz not null default now(),
                         data_as_of timestamptz not null default now())`);
      }
      await c.query(`grant connect on database ${this.name} to ebmr_app`);
      await c.query('grant usage on schema report to ebmr_app');
      await c.query('grant select on all tables in schema report to ebmr_app');
    });
    return this;
  }

  /** Adds (or replaces, as a new version) an item; returns its master id. */
  async put(kind: MasterTable, code: string, name: string, active = true): Promise<string> {
    return asAdmin(this.name, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into report.${kind}_v1 (code, name, active) values ($1, $2, $3)
         on conflict (code) do update set name = excluded.name, active = excluded.active, version = report.${kind}_v1.version + 1
         returning id::text as id`,
        [code, name, active],
      );
      return rows[0]?.id ?? '';
    });
  }

  async rename(kind: MasterTable, id: string, code: string, name: string): Promise<void> {
    await asAdmin(this.name, (c) => c.query(`update report.${kind}_v1 set code = $2, name = $3, version = version + 1 where id = $1`, [id, code, name]));
  }

  async cut(kind: MasterTable): Promise<void> {
    await asAdmin(this.name, (c) => c.query(`revoke select on report.${kind}_v1 from ebmr_app`));
  }

  async restore(kind: MasterTable): Promise<void> {
    await asAdmin(this.name, (c) => c.query(`grant select on report.${kind}_v1 to ebmr_app`));
  }

  async drop(): Promise<void> {
    await dropDatabase(this.name).catch(() => undefined);
  }
}
