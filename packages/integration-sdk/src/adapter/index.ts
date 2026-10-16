/**
 * `@ebmr/integration-sdk/adapter` (Phase 6 slice 6a-0): the adapter framework's contracts. No kernel import (the
 * simulators and adapters use this subpath; .dependency-cruiser.cjs rule integration-sdk-subpaths-no-kernel).
 * Fixed signatures and the builder split: docs/build-plan/phase-6/slice-6a-0-interfaces.md.
 */
export * from './envelope.ts';
export * from './errors.ts';
export * from './reconciliation.ts';
export * from './mirror.ts';
export * from './contract.ts';
export * from './equipment-data.ts';
export { ERP_WMS } from './systems/erp-wms.ts';
export { QMS } from './systems/qms.ts';
export { LIMS } from './systems/lims.ts';
export { LMS } from './systems/lms.ts';
export { CMMS } from './systems/cmms.ts';
export { EMS, EMS_TAGS, type EmsTag } from './systems/ems.ts';
export { ENDPOINT_LOCATION_NODE, EndpointCode, OpcuaEndpointSessionV1, opcuaSetpointNodeId, opcuaActiveAlarmsNodeId, opcuaEventsNodeId, OPCUA, OPCUA_NAMESPACE_URI, OPCUA_SECURITY_POLICIES, OPCUA_TAG_MAP, OpcuaEndpoint, RECIPE_VERSION_TAG, EQUIPMENT_DATA_REFUSALS, opcuaNodeId, parseOpcuaNodeId, type OpcuaTagEntry } from './systems/opcua.ts';
export { L3, L3_MIRROR_CLASS, L3AggregationV1, L3DecommissionTaskV1 } from './systems/l3.ts';

import type { SourceSystem } from './envelope.ts';
import type { SystemContract } from './contract.ts';
import { CMMS } from './systems/cmms.ts';
import { EMS } from './systems/ems.ts';
import { ERP_WMS } from './systems/erp-wms.ts';
import { L3 } from './systems/l3.ts';
import { LIMS } from './systems/lims.ts';
import { LMS } from './systems/lms.ts';
import { OPCUA } from './systems/opcua.ts';
import { QMS } from './systems/qms.ts';

/** Every system contract by its source system. */
export const SYSTEM_CONTRACTS: Readonly<Record<SourceSystem, SystemContract>> = { ERP_WMS, QMS, LIMS, LMS, CMMS, EMS, OPCUA, L3 };
