/** The reads of the operations screens (Phase 7 slice 7g-4), read again after each act. */
import { routes } from '@ebmr/api-contract';

const O = routes.operations;
export const DEMO_READS = [O.demo.id, O.demoJob.id] as const;
export const BACKUP_READS = [O.backups.id] as const;
export const WORKER_READS = [O.workers.id, routes.integrations.adapters.id, routes.integrations.adapter.id] as const;
export const SIMULATOR_READS = [O.simulators.id] as const;

/** A byte count as people read it (1 024 bytes a KiB), from whole-number text. */
export function bytes(text: string): string {
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  if (n < 1024) return `${text} bytes`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i] ?? 'KiB'} (${text} bytes)`;
}

/** "ADAPTER_START" -> "Adapter start". */
export function words(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
