/**
 * The fixed list of web features (module C0). Owners: session C0; access and audit C1; designer C2; floor C4; devices C5;
 * Phase 3 slice 6: planning, master-data, plant and quality (S6); Phase 4 slice 1c: review; slice 3c: release and notifications;
 * slice 5c: records (locking and amendment); slice 6c: pqr (PQR extract and sign-off); slice 6b: archive (retention, paper forms, true copies, inspection);
 * Phase 6 slice 6b: plant-status (alarms, status board, line station, rooms);
 * Phase 6 slice 6d: genealogy (explorer, complaint lookup, supply chain, deviation impact, mock recalls).
 * Phase 6 slice 6e: controlled (controlled-substance mode, draft IN-53).
 * Phase 6 slice 6i: transfers (inter-site packages, peers, receipts, alarms); the explorer and mock recalls ask other sites.
 * Phase 6 slice 6g: dashboards (dashboards, change impact; GMP) and training (SANDBOX).
 * Phase 6A slice 6A-1: analytics (overview, methods, flags; GMP). Phase 6A slice 6A-4: analytics-audit (audit-trail flags; GMP).
 * Phase 6A slice 6A-2: analytics-spc (control charts, capability, deviation rates; GMP).
 * Phase 6A slice 6A-3: analytics-mspc (multivariate monitoring; GMP).
 * Phase 6A slice 6A-5: analytics-review (one record's review priority; the queue's priority note; GMP).
 * Phase 7 slice 7g-1: administration (people and access, the device registry; both installations; decision 0025).
 * Phase 7 slice 7g-2 (decision 0025): master-records (MBR signatures, market authorisations, labelling specimens),
 * plant-rules (penicillin facility and beta-lactam proposals and QA approval) and incidents (register, CERT-In step); GMP.
 * Phase 7 slice 7g-4: operations (the first-run set-up, demo data, backups, workers, simulators, API reference).
 */
import * as access from '../features/access/index.tsx';
import * as administration from '../features/administration/index.tsx';
import * as analytics from '../features/analytics/index.tsx';
import * as analyticsAudit from '../features/analytics-audit/index.tsx';
import * as analyticsSpc from '../features/analytics/spc/index.tsx';
import * as analyticsMspc from '../features/analytics/mspc/index.tsx';
import * as analyticsReview from '../features/analytics-review/index.tsx';
import * as archive from '../features/archive/index.tsx';
import * as audit from '../features/audit/index.tsx';
import * as designer from '../features/designer/index.tsx';
import * as devices from '../features/devices/index.tsx';
import * as floor from '../features/floor/index.tsx';
import * as incidents from '../features/incidents/index.tsx';
import * as india from '../features/india/index.tsx';
import * as integrations from '../features/integrations/index.tsx';
import * as masterData from '../features/master-data/index.tsx';
import * as masterRecords from '../features/master-records/index.tsx';
import * as planning from '../features/planning/index.tsx';
import * as plant from '../features/plant/index.tsx';
import * as plantStatus from '../features/plant-status/index.tsx';
import * as plantRules from '../features/plant-rules/index.tsx';
import * as notifications from '../features/notifications/index.tsx';
import * as operations from '../features/operations/index.tsx';
import * as quality from '../features/quality/index.tsx';
import * as records from '../features/records/index.tsx';
import * as pqr from '../features/pqr/index.tsx';
import * as capa from '../features/capa/index.tsx';
import * as labels from '../features/labels/index.tsx';
import * as config from '../features/config/index.tsx';
import * as controlled from '../features/controlled/index.tsx';
import * as dashboards from '../features/dashboards/index.tsx';
import * as genealogy from '../features/genealogy/index.tsx';
import * as transfers from '../features/transfers/index.tsx';
import * as governance from '../features/governance/index.tsx';
import * as release from '../features/release/index.tsx';
import * as review from '../features/review/index.tsx';
import * as session from '../features/session/index.tsx';
import * as training from '../features/training/index.tsx';
import type { WebFeature } from './feature.ts';

export const WEB_FEATURES: readonly (readonly [string, WebFeature])[] = [
  ['session', session satisfies WebFeature],
  ['access', access satisfies WebFeature],
  ['audit', audit satisfies WebFeature],
  ['designer', designer satisfies WebFeature],
  ['floor', floor satisfies WebFeature],
  ['devices', devices satisfies WebFeature],
  ['planning', planning satisfies WebFeature],
  ['master-data', masterData satisfies WebFeature],
  ['plant', plant satisfies WebFeature],
  ['quality', quality satisfies WebFeature],
  ['review', review satisfies WebFeature],
  ['release', release satisfies WebFeature],
  ['notifications', notifications satisfies WebFeature],
  ['records', records satisfies WebFeature],
  ['pqr', pqr satisfies WebFeature],
  ['archive', archive satisfies WebFeature],
  ['india', india satisfies WebFeature],
  ['capa', capa satisfies WebFeature],
  ['labels', labels satisfies WebFeature],
  ['config', config satisfies WebFeature],
  ['governance', governance satisfies WebFeature],
  ['integrations', integrations satisfies WebFeature],
  ['controlled', controlled satisfies WebFeature],
  ['plant-status', plantStatus satisfies WebFeature],
  ['genealogy', genealogy satisfies WebFeature],
  ['transfers', transfers satisfies WebFeature],
  ['dashboards', dashboards satisfies WebFeature],
  ['training', training satisfies WebFeature],
  ['analytics', analytics satisfies WebFeature],
  ['analytics-audit', analyticsAudit satisfies WebFeature],
  ['analytics-spc', analyticsSpc satisfies WebFeature],
  ['analytics-mspc', analyticsMspc satisfies WebFeature],
  ['analytics-review', analyticsReview satisfies WebFeature],
  ['administration', administration satisfies WebFeature],
  ['master-records', masterRecords satisfies WebFeature],
  ['plant-rules', plantRules satisfies WebFeature],
  ['incidents', incidents satisfies WebFeature],
  // Phase 7 slice 7g-4 (decision 0025): operations without a terminal (set-up, demo data, backups, workers, simulators, API reference).
  ['operations', operations satisfies WebFeature],
];
