/**
 * Declutter slice D1 (docs/build-plan/declutter/plan.md section 3, "how the keep list is checked"): the screens of the
 * kept batch-record path call no route of a disconnected namespace, so they keep working where the server answers 410
 * DISCONNECTED (the platform build, or EBMR_DISCONNECT=1). The few disconnected screens that still live inside a kept
 * feature are named here for slice D2 to unhook; the parts a kept screen embeds from other features are named too.
 *
 * Control: DI-17.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISCONNECTED_NAMESPACES, DISCONNECTED_ROUTES } from '@ebmr/api-contract';
import { screenOff } from '../../src/app/disconnected.tsx';

const SRC = join(import.meta.dirname, '../../src');

/** The features of the kept path (plan section 1, with the owner's decisions of 5 November), and the shell. */
const KEPT_DIRS = [
  'app', 'device', 'api',
  ...['access', 'administration', 'audit', 'designer', 'devices', 'floor', 'india', 'labels', 'market', 'master-data', 'master-records',
    'operations', 'planning', 'plant', 'quality', 'records', 'release', 'review', 'session'].map((f) => `features/${f}`),
];

/** Disconnected screens inside kept features, for D2 to unhook (file → namespaces it calls). */
const D2_UNHOOK: Record<string, string[]> = {
  'features/labels/SerialisationPages.tsx': ['serialisation'],
  'features/labels/reads.ts': ['serialisation'],
  'features/release/QpPackage.tsx': ['qpPackage'],
  'features/release/QpReaderPage.tsx': ['qpPackage'],
  'features/release/reads.ts': ['notifications'],
  'features/release/LotReleasePage.tsx': ['notifications'],
};

/**
 * Kept files that embed a part of a feature outside the kept path (file → features), and why each is safe where the
 * server refuses DISCONNECTED: the part renders nothing on DISCONNECTED (isDisconnected), hides itself on any error,
 * makes no call, or reads a namespace that stays connected (alarms, DI-49).
 */
const EMBEDDED: Record<string, string[]> = {
  'features/floor/pages/StepScreen.tsx': ['plant-status'], // BatchAlarmLog: alarms stay connected
  'features/review/BatchReviewPage.tsx': ['plant-status'], // BatchAlarmLog: alarms stay connected
  'features/release/LotReleasePage.tsx': ['genealogy', 'notifications'], // RecurrenceWarning hides on error; DecisionNotifications
  'features/review/AuditTrailPanel.tsx': ['analytics-audit'], // useFlaggedEntries ignores errors
  'features/review/ReviewQueuePage.tsx': ['analytics-review'], // PriorityNote and QueueOrderingBand make no call
};

/**
 * Slice D4: the files of kept features that name a single disconnected route (DISCONNECTED_ROUTES, the full deviation
 * records), each a deviation screen switched off at /quality/deviations (DeviationsPage only names two ids among the
 * reads it refreshes). The lot page embeds DeviationDetail's release checklist, which reads quality.deviationRelease
 * (kept connected).
 */
const DEVIATION_SCREENS: Record<string, string[]> = {
  'features/quality/DeviationDetail.tsx': ['deviationDetail', 'reclassifyDeviation', 'recordDeviationClosureBasis', 'recordDeviationImpact'],
  'features/quality/DeviationPage.tsx': ['cancelDeviation', 'deviation'],
  'features/quality/DeviationsPage.tsx': ['deviation', 'deviationDetail'],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('[DI-17] the kept screens call no disconnected route (declutter D1)', () => {
  it('[DI-17] only the named disconnected screens inside kept features reach a disconnected namespace', () => {
    const pattern = new RegExp(`\\broutes\\.(${DISCONNECTED_NAMESPACES.join('|')})\\.`, 'g');
    const found: Record<string, string[]> = {};
    for (const file of KEPT_DIRS.flatMap((d) => files(join(SRC, d)))) {
      const hits = [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => m[1] ?? '');
      if (hits.length > 0) found[relative(SRC, file)] = [...new Set(hits)].sort();
    }
    expect(found).toEqual(D2_UNHOOK);
  });

  it('[DI-17] a kept screen embeds a part of another feature only where that part is safe on DISCONNECTED', () => {
    const keptFeatures = new Set(KEPT_DIRS.filter((d) => d.startsWith('features/')).map((d) => d.slice('features/'.length)));
    const found: Record<string, string[]> = {};
    // app/features.ts registers every feature's routes and tiles: the home and the menus are slice D2.
    for (const file of KEPT_DIRS.flatMap((d) => files(join(SRC, d))).filter((f) => relative(SRC, f) !== 'app/features.ts')) {
      const outside = [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)]
        .map((m) => relative(SRC, join(dirname(file), m[1] ?? '')).split('/'))
        .filter((parts) => parts[0] === 'features' && parts[1] !== undefined && !keptFeatures.has(parts[1]))
        .map((parts) => parts[1] ?? '');
      if (outside.length > 0) found[relative(SRC, file)] = [...new Set(outside)].sort();
    }
    expect(found).toEqual(EMBEDDED);
  });
});

describe('[DI-17] the kept screens call no disconnected deviation route (declutter D4)', () => {
  it('[DI-17] only the deviation screens, switched off where the functions are disconnected, name a disconnected deviation route', () => {
    const names = Object.keys(DISCONNECTED_ROUTES).map((id) => id.split('.'));
    const pattern = new RegExp(`\\broutes\\.(${names.map(([ns, name]) => `${ns ?? ''}\\.${name ?? ''}`).join('|')})\\b`, 'g');
    const found: Record<string, string[]> = {};
    for (const file of KEPT_DIRS.flatMap((d) => files(join(SRC, d)))) {
      const hits = [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => (m[1] ?? '').split('.')[1] ?? '');
      if (hits.length > 0) found[relative(SRC, file)] = [...new Set(hits)].sort();
    }
    expect(found).toEqual(DEVIATION_SCREENS);
    for (const path of ['/quality/deviations', '/quality/deviations/123']) {
      expect(screenOff(path, true, false), path).toBe(true);
      expect(screenOff(path, false, false), path).toBe(false);
    }
    for (const path of ['/quality', '/quality/lots/123', '/records/123', '/release/123']) expect(screenOff(path, true, false), path).toBe(false);
  });
});
