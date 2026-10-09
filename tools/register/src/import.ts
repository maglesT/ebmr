/**
 * One-time (re-runnable) import of the control catalogs into compliance/controls/*.yaml.
 *
 * Re-running keeps any fields a person has since edited in the YAML (implemented_by, tests, clauses,
 * deferred_scope, expert_decision, build_status, proposed_modify, target_phase when its source is not 'outline'),
 * so the import never overwrites decisions or build progress.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { controlTypes, coveredRows, editionsOf, parseCatalog, type ParsedControl } from './catalog-parser.ts';
import { assignPhase, phaseExitIds } from './phases.ts';
import { CONTROLS_DIR, ROOT, type ControlRecord } from './register.ts';

const CATALOGS: [ParsedControl['part'], string][] = [
  ['A', 'docs/regulatory/control-catalogs/A-data-integrity.md'],
  ['B', 'docs/regulatory/control-catalogs/B-production-documentation-release.md'],
  ['C', 'docs/regulatory/control-catalogs/C-sterile-injectables.md'],
  ['D', 'docs/regulatory/control-catalogs/D-india-schedule-m.md'],
];

/** Outline proposals that go beyond a catalog control; the expert decides them (outline 3.1). */
const PROPOSED_MODIFY: Record<string, string> = {
  'DI-15': 'Refuse to issue US-market batches until the 21 CFR 11.100(c) certification record is on file (catalog only flags it).',
  'ST-33': 'Owner decision 0001 #2 (B): the US-only FDA tier profile is not offered in v1; any contaminated unit fails the APS on every line.',
  'DI-25': 'Widen the batch audit-trail review to audit events on records the batch relied on: lots, equipment, qualifications, EM results, cycles, rules (critique R-17 / L-10).',
};

const KEEP_FIELDS = ['implemented_by', 'tests', 'clauses', 'deferred_scope', 'expert_decision', 'build_status', 'proposed_modify'] as const;

export function importCatalogs(): { written: number; ids: string[] } {
  const outline = readFileSync(join(ROOT, 'docs/outline/build-outline.md'), 'utf8');
  const exits = phaseExitIds(outline);
  mkdirSync(CONTROLS_DIR, { recursive: true });
  const ids: string[] = [];
  for (const [part, file] of CATALOGS) {
    for (const c of parseCatalog(readFileSync(join(ROOT, file), 'utf8'), part)) {
      const editions = editionsOf(c);
      const phase = assignPhase(c, editions, exits);
      const f = c.fields;
      const record: ControlRecord = {
        id: c.id,
        title: c.title.replace(/\s*\[(T|I)(, [^\]]*)?\]\s*/g, ' ').trim(),
        part,
        group: c.group,
        editions,
        type: controlTypes(f['Type']),
        target_phase: phase.phase,
        target_phase_source: phase.source,
        requirement_rows: coveredRows(f['Covers']),
        sources: f['Citations'] ?? '',
        behaviour: f['Behaviour'] ?? '',
        catalog_test: f['Test'] ?? '',
        implemented_by: {},
        tests: [],
        expert_decision: { status: 'PENDING', pack_version: '0.9' },
        build_status: 'SPECIFIED',
      };
      if (f['Jurisdiction']) record.jurisdiction = f['Jurisdiction'];
      if (f['Scope']) record.scope = f['Scope'];
      if (f['Type'] && f['Type'].length > 14) record.type_detail = f['Type'];
      const notes = [f['Notes'], f['Verification'] && `Source check: ${f['Verification']}`, f['Defaults'] && `Defaults: ${f['Defaults']}`]
        .filter(Boolean)
        .join('\n');
      if (notes) record.notes = notes;
      const proposed = PROPOSED_MODIFY[c.id];
      if (proposed) record.proposed_modify = proposed;

      const path = join(CONTROLS_DIR, `${c.id}.yaml`);
      if (existsSync(path)) {
        const existing = YAML.parse(readFileSync(path, 'utf8')) as Partial<ControlRecord>;
        for (const k of KEEP_FIELDS) if (existing[k] !== undefined) (record as unknown as Record<string, unknown>)[k] = existing[k];
        if (existing.target_phase_source === 'default' && existing.target_phase !== undefined && phase.source === 'default') {
          record.target_phase = existing.target_phase;
        }
      }
      writeFileSync(path, YAML.stringify(record, { lineWidth: 0, blockQuote: 'literal' }));
      ids.push(c.id);
    }
  }
  return { written: ids.length, ids };
}
