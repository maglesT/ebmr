/**
 * The qualification documents (Phase 7 slice 7c; IN-12, DI-03, DI-04): the IQ protocol and record, the OQ protocol and
 * record, the PQ template for the customer's own master records, and the periodic-review template.
 *
 * The IQ checks are named here (IQ_CHECKS) so the executable check of tools/validation (`pnpm validation:iq`) and this
 * protocol name the same checks; the record of a run is a bundle record of kind `iq` (or `oq`), its file hashed.
 */
import { compareText } from '../bundle/validate.ts';
import type { Bundle, PhaseRecord } from '../bundle/types.ts';
import { fields, heading, list, para, signature, table, type Doc } from './doc.ts';
import { verdicts } from './facts.ts';

export interface IqCheck {
  id: string;
  name: string;
  /** What the check expects, in words. */
  expected: string;
}

/** The checks of the IQ script, in order (interfaces section 1d; plan, slice 7c "IQ script and record"). */
export const IQ_CHECKS: readonly IqCheck[] = [
  { id: 'IQ-01', name: 'release identity', expected: 'platform.schema_release() of the installation equals the release\'s schema release in the bundle (the migration ledger hash)' },
  { id: 'IQ-02', name: 'migrations', expected: 'every migration of the release is applied with the SHA-256 of its file, and none other' },
  { id: 'IQ-03', name: 'package versions', expected: 'the product version and the shared packages\' versions equal the bundle\'s release and SBOM' },
  { id: 'IQ-04', name: 'triggers', expected: 'every trigger of the release inventory exists on its table and is enabled' },
  { id: 'IQ-05', name: 'constraints', expected: 'every constraint of the release inventory exists with the same definition' },
  { id: 'IQ-06', name: 'privileges', expected: 'every privilege of the release inventory is granted, and the application roles hold no other table privilege' },
  { id: 'IQ-07', name: 'SECURITY DEFINER functions', expected: 'every function of the release inventory exists with the same SECURITY DEFINER flag and EXECUTE grants' },
  { id: 'IQ-08', name: 'roles', expected: 'the application, authentication and listener roles are not superusers, cannot create roles and do not bypass row security' },
  { id: 'IQ-09', name: 'locked settings', expected: 'no DEMO-ONLY key is registered or configured; the server refuses plain HTTP; PostgreSQL requires TLS and stores passwords as SCRAM-SHA-256' },
  { id: 'IQ-10', name: 'adapters', expected: 'every active integration adapter is in the approved system description with its transport (DI-06)' },
  { id: 'IQ-11', name: 'installation kind', expected: 'the database is marked GMP and its name agrees (DI-05)' },
];

function recordBlocks(r: PhaseRecord | undefined, what: string): Doc['blocks'] {
  if (!r) return [para(`No ${what} record is in this bundle: the record is written by running the script on the installation, then the bundle is built again with it.`)];
  return [
    fields([
      ['Record file', r.file],
      ['SHA-256', r.sha256],
      ['Result', r.passed ? 'PASSED' : 'FAILED'],
      ['Summary', r.summary],
    ]),
    table(['Check', 'Actual', 'Unit', 'Expected'], r.measures.map((m) => [m.name, m.value, m.unit, m.limit ?? '-'])),
  ];
}

export function iq(b: Bundle): Doc {
  const inv = b.inventory;
  return {
    id: 'iq',
    title: 'Installation qualification: protocol and record',
    status: 'RELEASED',
    blocks: [
      para(`Executable: \`pnpm validation:iq --db <url> --server <url> --bundle <file>\` checks the installation against this release (${b.release.version}, schema release ${b.release.schemaRelease}) and writes the IQ record with each check's expected and actual value.`),
      heading('Protocol'),
      table(['Check', 'Name', 'Expected'], IQ_CHECKS.map((c) => [c.id, c.name, c.expected])),
      heading('What the release expects'),
      table(
        ['Item', 'Count in the release inventory'],
        [
          ['migrations', String(inv.migrations.length)],
          ['triggers', String(inv.triggers.length)],
          ['constraints', String(inv.constraints.length)],
          ['privileges', String(inv.privileges.length)],
          ['SECURITY DEFINER functions', String(inv.functions.filter((f) => f.securityDefiner).length)],
          ['roles', String(inv.roles.length)],
        ],
      ),
      heading('Record'),
      ...recordBlocks(b.records.find((r) => r.kind === 'iq'), 'IQ'),
      heading('Approval'),
      signature(['Performed by', 'Reviewed by (QA)']),
    ],
  };
}

export function oq(b: Bundle): Doc {
  const v = verdicts(b);
  const runs = b.runs.map((r) => [r.id, r.kind, r.commit, r.startedAt, r.finishedAt, r.reportFile, r.reportSha256, `${r.host.os}; node ${r.host.node}; postgres ${r.host.postgres ?? '-'}`]);
  const tally = (s: string) => String([...v.values()].filter((x) => x.verdict === s).length);
  return {
    id: 'oq',
    title: 'Operational qualification: protocol and record',
    status: 'RELEASED',
    blocks: [
      para('Executable: `pnpm validation:oq --server <url>` runs the regression suite, the golden batches and the browser suite against the installation; each run\'s report is hashed into the bundle, and the browser suite keeps its per-step evidence.'),
      heading('Runs'),
      table(['Run', 'Kind', 'Commit', 'Started', 'Finished', 'Report', 'Report SHA-256', 'Host'], runs),
      heading('Summary'),
      table(['Verdict', 'Tests'], [['PASSED', tally('PASSED')], ['FAILED', tally('FAILED')], ['SKIPPED', tally('SKIPPED')]]),
      heading('Record: every test with its controls and result'),
      table(
        ['Test', 'Controls', 'Run', 'Result', 'Duration (ms)', 'Evidence'],
        b.results.map((r) => [r.test, r.controls.join(', ') || '-', r.run, r.status, String(r.durationMs), r.evidence ? 'browser step record' : '-']),
      ),
      ...recordBlocks(b.records.find((r) => r.kind === 'oq'), 'OQ'),
      heading('Approval'),
      signature(['Performed by', 'Reviewed by (QA)']),
    ],
  };
}

export function pqTemplate(b: Bundle): Doc {
  return {
    id: 'pq-template',
    title: 'Performance qualification template (one per master batch record)',
    status: 'TEMPLATE',
    blocks: [
      para(
        `Qualifying ${b.release.product} does not prove that a given master batch record is right (DI-04): the platform's IQ and OQ show the system works as specified; each master the customer writes is verified on its own before GMP use. Copy this template for each MBR.`,
      ),
      fields([
        ['MBR code and version', ''],
        ['Product, strength, batch size', ''],
        ['Markets', ''],
        ['Site, line and rooms', ''],
        ['Release of the system', `${b.release.version} (schema release ${b.release.schemaRelease})`],
      ]),
      heading('Verification steps'),
      list(
        [
          'Review the MBR content against the approved process description and the registration dossier of each market: every step, parameter, limit and calculation.',
          'Run the MBR in the sandbox as a test batch with values just inside, on and just outside each limit; confirm each limit acts as specified and each out-of-limit value is refused or raised as an exception.',
          'Confirm each calculation (dispensed quantities, yields, reconciliation) against a hand worksheet with the same inputs.',
          'Confirm each signature the MBR requires is asked of the right role with the right meaning, and witnessed steps need a second person.',
          'Confirm the equipment, materials and labels the MBR names are the qualified ones of the site.',
          'Review the executed test record and its exceptions; confirm the batch record prints as a complete, readable true copy.',
          'Record each deviation found and its resolution; repeat the run after a change to the MBR.',
        ],
        true,
      ),
      heading('Acceptance criteria'),
      table(['Criterion', 'Expected', 'Observed', 'Pass or fail'], [
        ['Every limit acts on its boundary values', '', '', ''],
        ['Every calculation equals the worksheet', '', '', ''],
        ['Every signature is asked of the right role and meaning', '', '', ''],
        ['No unresolved deviation', '', '', ''],
      ]),
      heading('Approval'),
      signature(['MBR author', 'Process owner', 'QA approver']),
    ],
  };
}

export function periodicReviewTemplate(b: Bundle): Doc {
  return {
    id: 'periodic-review-template',
    title: 'Periodic review template of the computerised system',
    status: 'TEMPLATE',
    blocks: [
      para(`A periodic review of ${b.release.product} confirms the system stays in a validated state. Review period and frequency are set by the customer's validation master plan.`),
      fields([
        ['Review period', ''],
        ['Release in use', `${b.release.version} (schema release ${b.release.schemaRelease})`],
      ]),
      heading('Items to review'),
      list([
        'Changes since the last review: releases, configuration change records, interfaces added or withdrawn (the approved system description against the installation\'s export; any interface drift alarm).',
        'Deviations, incidents and CAPAs that involve the system.',
        'Audit-trail review findings and the integrity job\'s alarms (record and signature hashes).',
        'Access review: accounts, role grants, segregation of duties, dormant accounts.',
        'Backup and restore tests, and the business continuity procedure.',
        'Open known issues of the supplier and their workarounds.',
        'Training of users on the current release.',
      ]),
      heading('Conclusion'),
      para('Left for the customer\'s QA: the system remains / does not remain in a validated state; actions and their owners.'),
      heading('Approval'),
      signature(['System owner', 'QA']),
    ],
  };
}

/** The record kinds of the bundle in order, for the summary. */
export const recordKinds = (b: Bundle): string[] => b.records.map((r) => r.kind).sort(compareText);
