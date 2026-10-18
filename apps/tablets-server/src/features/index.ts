/**
 * The fixed list of feature modules (plan section 3). Owners: meta and session C0; access, esig and audit C1;
 * designer C2 (GMP); execution C3 and devices C5 on both installations since Phase 3 slice 2b (test packages and test
 * batches stay sandbox-only, the GMP batch issue GMP-only, by the contract's route installations; each installation has its
 * own gateways and scales). A module replaces only its own index.ts. Phase 3 slice 6: planning, master-data
 * (formulation library) and plant on GMP; the GMP batch family `/api/batches/*` is bound by execution (D-S6-1). Phase 4
 * slice 1: review on GMP. Phase 4 slice 2b: lims (specifications, samples, returned goods; quality/lims.ts) on GMP. Phase 4 slice 3: release and notifications on GMP. Phase 4 slice 4b: qp-package and erp-shipping on GMP. Phase 4 slice 5b: records (locking, amendment, bulk reconciliation) on GMP. Phase 4 slice 6c: pqr (PQR extract and sign-off) on GMP. Phase 4 slice 6b: archive (retention, contingency packs, evidence export, inspection) on GMP. Phase 6 slice 6b-0: alarms (plant alarm log) and equipment-data (native series, equipment events, original records) on GMP. Phase 6 slice 6d: genealogy (genealogy and recall namespaces) on GMP. Phase 6 slice 6g: dashboards (dashboards and changeImpact) on GMP, training on the SANDBOX only. Phase 6 slice 6i: transfers (transfers and federation namespaces) on GMP. Phase 6A slice 6A-1: analytics (analytics and analyticsConfig namespaces) on GMP. Phase 6A slice 6A-4: analytics-audit (analyticsAudit) on GMP. Phase 6A slice 6A-2: analytics-spc (analyticsSpc) on GMP. Phase 6A slice 6A-5: analytics-review (analyticsReview) on GMP. Phase 6A slice 6A-6: analytics-profile (analyticsProfile) on GMP. Phase 6A slice 6A-3: analytics-mspc (analyticsMspc) on GMP. Phase 7 slice 7g-2: incidents (the incident register and its CERT-In step) on GMP.
 */
import * as access from './access/index.ts';
import * as alarms from './alarms/index.ts';
import * as archive from './archive/index.ts';
import * as audit from './audit/index.ts';
import * as capa from './capa/index.ts';
import * as controlled from './controlled/index.ts';
import * as labels from './labels/index.ts';
import * as serialisation from './serialisation/index.ts';
import * as configChange from './config-change/index.ts';
import * as containers from './containers/index.ts';
import * as dashboards from './dashboards/index.ts';
import * as designer from './designer/index.ts';
import * as devices from './devices/index.ts';
import * as esig from './esig/index.ts';
import * as equipmentData from './equipment-data/index.ts';
import * as plantRules from './plant-rules/index.ts';
import * as governance from './governance/index.ts';
import * as erpShipping from './erp-shipping/index.ts';
import * as execution from './execution/index.ts';
import * as genealogy from './genealogy/index.ts';
import * as incidents from './incidents/index.ts';
import * as india from './india/index.ts';
import * as masterData from './master-data/index.ts';
import * as integrations from './integrations/index.ts';
import * as meta from './meta/index.ts';
import * as planning from './planning/index.ts';
import * as plant from './plant/index.ts';
import * as qpPackage from './qp-package/index.ts';
import * as quality from './quality/index.ts';
import * as lims from './quality/lims.ts';
import * as notifications from './notifications/index.ts';
import * as records from './records/index.ts';
import * as pqr from './pqr/index.ts';
import * as release from './release/index.ts';
import * as analytics from './analytics/index.ts';
import * as analyticsAudit from './analytics/audit/index.ts';
import * as analyticsProfile from './analytics/profile/index.ts';
import * as analyticsSpc from './analytics/spc/index.ts';
import * as analyticsMspc from './analytics/mspc/index.ts';
import * as analyticsReview from './analytics/review/index.ts';
import * as review from './review/index.ts';
import * as session from './session/index.ts';
import * as transfers from './transfers/index.ts';
import * as training from './training/index.ts';
import type { FeatureEntry, FeatureModule } from './types.ts';

export const FEATURES: readonly FeatureEntry[] = [
  { name: 'meta', installations: ['GMP', 'SANDBOX'], module: meta satisfies FeatureModule },
  { name: 'session', installations: ['GMP', 'SANDBOX'], module: session satisfies FeatureModule },
  { name: 'access', installations: ['GMP', 'SANDBOX'], module: access satisfies FeatureModule },
  { name: 'esig', installations: ['GMP', 'SANDBOX'], module: esig satisfies FeatureModule },
  { name: 'audit', installations: ['GMP', 'SANDBOX'], module: audit satisfies FeatureModule },
  { name: 'designer', installations: ['GMP'], module: designer satisfies FeatureModule },
  { name: 'execution', installations: ['GMP', 'SANDBOX'], module: execution satisfies FeatureModule },
  { name: 'devices', installations: ['GMP', 'SANDBOX'], module: devices satisfies FeatureModule },
  { name: 'quality', installations: ['GMP'], module: quality satisfies FeatureModule },
  { name: 'planning', installations: ['GMP'], module: planning satisfies FeatureModule },
  { name: 'master-data', installations: ['GMP'], module: masterData satisfies FeatureModule },
  { name: 'plant', installations: ['GMP'], module: plant satisfies FeatureModule },
  { name: 'review', installations: ['GMP'], module: review satisfies FeatureModule },
  { name: 'containers', installations: ['GMP'], module: containers satisfies FeatureModule },
  { name: 'lims', installations: ['GMP'], module: lims satisfies FeatureModule },
  { name: 'release', installations: ['GMP'], module: release satisfies FeatureModule },
  { name: 'notifications', installations: ['GMP'], module: notifications satisfies FeatureModule },
  { name: 'qp-package', installations: ['GMP'], module: qpPackage satisfies FeatureModule },
  { name: 'erp-shipping', installations: ['GMP'], module: erpShipping satisfies FeatureModule },
  { name: 'records', installations: ['GMP'], module: records satisfies FeatureModule },
  { name: 'pqr', installations: ['GMP'], module: pqr satisfies FeatureModule },
  { name: 'archive', installations: ['GMP'], module: archive satisfies FeatureModule },
  { name: 'india', installations: ['GMP'], module: india satisfies FeatureModule },
  { name: 'integrations', installations: ['GMP'], module: integrations satisfies FeatureModule },
  { name: 'capa', installations: ['GMP'], module: capa satisfies FeatureModule },
  { name: 'alarms', installations: ['GMP'], module: alarms satisfies FeatureModule },
  { name: 'equipment-data', installations: ['GMP'], module: equipmentData satisfies FeatureModule },
  { name: 'plant-rules', installations: ['GMP'], module: plantRules satisfies FeatureModule },
  { name: 'labels', installations: ['GMP'], module: labels satisfies FeatureModule },
  { name: 'serialisation', installations: ['GMP'], module: serialisation satisfies FeatureModule },
  { name: 'config-change', installations: ['GMP'], module: configChange satisfies FeatureModule },
  { name: 'governance', installations: ['GMP'], module: governance satisfies FeatureModule },
  { name: 'controlled', installations: ['GMP'], module: controlled satisfies FeatureModule },
  { name: 'genealogy', installations: ['GMP'], module: genealogy satisfies FeatureModule },
  { name: 'transfers', installations: ['GMP'], module: transfers satisfies FeatureModule },
  { name: 'dashboards', installations: ['GMP'], module: dashboards satisfies FeatureModule },
  { name: 'training', installations: ['SANDBOX'], module: training satisfies FeatureModule },
  { name: 'analytics', installations: ['GMP'], module: analytics satisfies FeatureModule },
  { name: 'analytics-audit', installations: ['GMP'], module: analyticsAudit satisfies FeatureModule },
  { name: 'analytics-profile', installations: ['GMP'], module: analyticsProfile satisfies FeatureModule },
  { name: 'analytics-spc', installations: ['GMP'], module: analyticsSpc satisfies FeatureModule },
  { name: 'analytics-mspc', installations: ['GMP'], module: analyticsMspc satisfies FeatureModule },
  { name: 'analytics-review', installations: ['GMP'], module: analyticsReview satisfies FeatureModule },
  { name: 'incidents', installations: ['GMP'], module: incidents satisfies FeatureModule },
];

export type { FeatureEntry, FeatureModule, FeatureSeedContext } from './types.ts';
