/**
 * The DEMO-ONLY documents the route B masters pin (Phase 7 slice 7n, requirement R7; cli/demo-route-masters-b.ts): the
 * beta-lactam product made in its dedicated suite. All invented; spread into the catalogue by reference-catalogue.ts.
 */
import type { ReferenceDocumentKind, ReferenceDocumentSeed } from './reference-catalogue.ts';

export function betaLactamReferenceDocuments(): ReferenceDocumentSeed[] {
  const doc = (kind: ReferenceDocumentKind, code: string, title: string, summary: string): ReferenceDocumentSeed => ({ kind, code, version: '1', title, effectiveFrom: '2024-01-01', summary });
  return [
    doc('SOP', 'SOP-RTB-PROC', 'Route B: beta-lactam suite, dispensing at low humidity, direct compression and film coating', 'Entry to the dedicated suite, room humidity checks, potency-adjusted dispensing of both actives, blending, compression and film coating at low humidity.'),
    doc('MATERIAL', 'MAT-CXP-PX', 'Cefexemplone proxetil (invented cephalosporin)', 'Active substance specification (invented beta-lactam): identity, assay as is, water.'),
    doc('MATERIAL', 'MAT-CLX-K', 'Clavexemplate potassium (invented beta-lactamase inhibitor)', 'Active substance specification (invented beta-lactam, moisture sensitive): identity, assay as is, water.'),
    doc('MATERIAL', 'MAT-MAN-SD', 'Mannitol, spray-dried (direct-compression grade)', 'Excipient specification (compensating excipient of the beta-lactamase inhibitor; low moisture).'),
    doc('MATERIAL', 'MAT-ALU-CFD', 'Cold-form aluminium laminate with desiccant layer (forming web)', 'Primary packaging specification (cold-form laminate with an integrated desiccant layer).'),
    doc('MATERIAL', 'MAT-ALU-CXC', 'Printed aluminium lidding foil, route B', 'Printed primary packaging specification (lidding foil, artwork controlled).'),
    doc('MATERIAL', 'MAT-CTN-CXC', 'Printed carton, route B 10 x 10', 'Printed secondary packaging specification (carton, artwork controlled).'),
    doc('REGISTRATION', 'REG-RTB', 'Cefexemplone proxetil and clavexemplate potassium tablets 325 mg: registered process and specification (invented)', 'Registered process ranges, the dedicated facility and the specification of the invented route B product.'),
    doc('VALIDATION_REPORT', 'VR-RTB', 'Process validation report: route B (invented)', 'Room humidity limits, blend and lubrication times, weight gain and the stage yields (DEMO-ONLY short times).'),
    doc('VALIDATION_REPORT', 'VR-RTB-PK', 'Packaging validation report: route B cold-form blister with desiccant (invented)', 'Sealing ranges, leak-test method and the packaging yield.'),
    doc('RISK_ASSESSMENT', 'QRM-RTB-IPC', 'Risk assessment of the route B in-process check frequency', 'Weight checks of each press side every 25 minutes.'),
    doc('RISK_ASSESSMENT', 'QRM-RTB-LEAK', 'Risk assessment of the route B leak-test frequency', 'Leak tests at the start and the end of each run and every two hours.'),
    doc('HOLD_STUDY', 'HS-RTB', 'Hold-time study: route B intermediates', 'Maximum hold of the lubricated blend and the coated tablets in closed containers with desiccant.'),
  ];
}
