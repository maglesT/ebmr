/**
 * Plant master data (Phase 3 slice 6): areas, equipment classes, equipment, tooling sets, detectors, test pieces and
 * utilities of the site (and, slice 7h gap C4, the plant's product list), each with its list and its definition form. Every rule is the database's (recipe-core 0400 to
 * 0405, tablets 0871, 0872); a refusal is shown in the server's words.
 */
import { useState } from 'react';
import { routes, type AnyRoute } from '@ebmr/api-contract';
import { floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { DefineForm, type FormField } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const CODE = 'Upper-case letters, digits, dashes';
const INTERVAL = 'e.g. "72 hours"';

interface Kind {
  title: string;
  list: AnyRoute;
  key: string;
  define: AnyRoute;
  columns: readonly (readonly [string, string])[];
  fields: readonly FormField[];
}

const KINDS: Readonly<Record<string, Kind>> = {
  // Slice 7h WP-C (gap C4): the plant's product list (plant.define_product; MASTERDATA.CHANGE; IN-26 (c)).
  products: {
    title: 'Products',
    list: routes.plant.products,
    key: 'products',
    define: routes.plant.defineProduct,
    columns: [['code', 'Code'], ['name', 'Name'], ['highlyPotent', 'Highly potent'], ['recordedBy', 'Recorded by'], ['recordedAt', 'Recorded']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: 'The product code of the master records and the ERP' },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'highlyPotent', label: 'Highly potent', kind: 'yesno' },
    ],
  },
  areas: {
    title: 'Areas',
    list: routes.plant.areas,
    key: 'areas',
    define: routes.plant.defineArea,
    columns: [['code', 'Code'], ['kind', 'Kind'], ['name', 'Name'], ['segregated', 'Segregated'], ['negativePressure', 'Negative pressure'], ['state', 'State']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'kind', label: 'Kind', kind: 'choice', options: ['ROOM', 'LINE'] },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'segregated', label: 'Segregated', kind: 'yesno', optional: true },
      { name: 'segregationJustification', label: 'Segregation justification', kind: 'text', optional: true },
      { name: 'negativePressure', label: 'Negative pressure', kind: 'yesno', optional: true },
    ],
  },
  classes: {
    title: 'Equipment classes',
    list: routes.plant.equipmentClasses,
    key: 'classes',
    define: routes.plant.defineEquipmentClass,
    columns: [['code', 'Code'], ['kind', 'Kind'], ['description', 'Description'], ['cleanHold', 'Clean hold'], ['dirtyHold', 'Dirty hold'], ['calibrationRequired', 'Calibration'], ['checkRegime', 'Checks']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'kind', label: 'Kind', kind: 'choice', options: ['PROCESS', 'INSTRUMENT', 'UTILITY'] },
      { name: 'description', label: 'Description', kind: 'text' },
      { name: 'cleanHold', label: 'Clean hold time', kind: 'text', optional: true, description: INTERVAL },
      { name: 'dirtyHold', label: 'Dirty hold time', kind: 'text', optional: true, description: INTERVAL },
      { name: 'calibrationRequired', label: 'Calibration required', kind: 'yesno', optional: true },
      { name: 'checkRegime', label: 'Check regime', kind: 'choice', options: ['PER_USE', 'DAILY'], optional: true },
      { name: 'cipValidationRef', label: 'CIP validation reference', kind: 'text', optional: true },
    ],
  },
  equipment: {
    title: 'Equipment',
    list: routes.plant.equipment,
    key: 'equipment',
    define: routes.plant.defineEquipment,
    columns: [['code', 'Code'], ['name', 'Name'], ['classCode', 'Class'], ['areaCode', 'Area'], ['state', 'State'], ['fitness', 'Not usable because']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'classCode', label: 'Class', kind: 'text' },
      { name: 'areaCode', label: 'Area', kind: 'text', optional: true },
    ],
  },
  tooling: {
    title: 'Tooling sets',
    list: routes.plant.toolingSets,
    key: 'toolingSets',
    define: routes.plant.defineToolingSet,
    columns: [['code', 'Code'], ['product', 'Product'], ['type', 'Type'], ['shape', 'Shape'], ['upperEmbossing', 'Upper'], ['lowerEmbossing', 'Lower'], ['tips', 'Tips'], ['strokeLimit', 'Stroke limit']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'product', label: 'Product', kind: 'text' },
      { name: 'type', label: 'Type', kind: 'choice', options: ['B', 'D', 'BB'] },
      { name: 'shape', label: 'Shape', kind: 'text' },
      { name: 'upperEmbossing', label: 'Upper embossing', kind: 'text' },
      { name: 'lowerEmbossing', label: 'Lower embossing', kind: 'text' },
      { name: 'score', label: 'Score', kind: 'text' },
      { name: 'tips', label: 'Tips per punch', kind: 'int' },
      { name: 'upperPunches', label: 'Upper punches', kind: 'int' },
      { name: 'lowerPunches', label: 'Lower punches', kind: 'int' },
      { name: 'dies', label: 'Dies', kind: 'int' },
      { name: 'strokeLimit', label: 'Stroke limit', kind: 'text', description: 'A whole number' },
    ],
  },
  detectors: {
    title: 'Detectors',
    list: routes.plant.detectors,
    key: 'detectors',
    define: routes.plant.defineDetector,
    columns: [['code', 'Code'], ['name', 'Name'], ['device', 'Device'], ['classCode', 'Class'], ['areaCode', 'Area']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'device', label: 'Device', kind: 'choice', options: ['METAL_DETECTOR', 'REJECT_GATE'] },
      { name: 'classCode', label: 'Class', kind: 'text' },
      { name: 'areaCode', label: 'Area', kind: 'text', optional: true },
    ],
  },
  testPieces: {
    title: 'Test pieces',
    list: routes.plant.testPieces,
    key: 'testPieces',
    define: routes.plant.defineTestPiece,
    columns: [['code', 'Code'], ['kind', 'Kind'], ['size', 'Size'], ['certificateRef', 'Certificate'], ['certifiedUntil', 'Certified until']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'kind', label: 'Kind', kind: 'choice', options: ['FERROUS', 'NON_FERROUS', 'STAINLESS', 'REJECT_SAMPLE'] },
      { name: 'size.value', label: 'Size', kind: 'decimal' },
      { name: 'size.unit', label: 'Size unit', kind: 'choice', options: ['mm', 'mg', 'units'] },
      { name: 'certificateRef', label: 'Certificate reference', kind: 'text' },
      { name: 'certifiedUntil', label: 'Certified until', kind: 'instant', description: 'ISO-8601 with offset, e.g. 2027-03-31T23:59:59+05:30' },
    ],
  },
  utilities: {
    title: 'Utilities',
    list: routes.plant.utilities,
    key: 'utilities',
    define: routes.plant.defineUtility,
    columns: [['code', 'Code'], ['name', 'Name'], ['classCode', 'Class'], ['areaCode', 'Area'], ['state', 'State']],
    fields: [
      { name: 'code', label: 'Code', kind: 'text', description: CODE },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'classCode', label: 'Class', kind: 'text' },
      { name: 'areaCode', label: 'Area', kind: 'text', optional: true },
    ],
  },
};

/** A cell as text (instants by their text, sizes with their unit, yes/no in words). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['text'] === 'string') return o['text'];
    if (typeof o['legalName'] === 'string') return o['legalName'];
    if (typeof o['value'] === 'string' && typeof o['unit'] === 'string') return `${o['value']} ${o['unit']}`;
    return JSON.stringify(v);
  }
  return typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
}

function KindPanel({ kind }: { kind: Kind }) {
  const q = useApiQuery(kind.list);
  const steward = useOffered('PLANT_MASTER');
  const rows = ((q.data as Record<string, unknown> | undefined)?.[kind.key] ?? []) as Record<string, unknown>[];
  return (
    <section aria-label={kind.title} data-testid={`plant-${kind.key}`}>
      <h2>{kind.title}</h2>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <table aria-label={kind.title}>
        <thead>
          <tr>
            {kind.columns.map(([, label]) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={cellText(r['code']) + String(i)}>
              {kind.columns.map(([name]) => (
                <td key={name}>{cellText(r[name])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {steward ? <DefineForm title={`Define: ${kind.title}`} route={kind.define} fields={kind.fields} refresh={[kind.list.id]} submitLabel="Define" /> : null}
    </section>
  );
}

export function PlantMasterPage() {
  const [tab, setTab] = useState('areas');
  const kind = KINDS[tab] ?? KINDS['areas'];
  return (
    <>
      <h1>Plant master data</h1>
      <floor.ChoiceGroup label="Show" options={Object.entries(KINDS).map(([k, v]) => ({ value: k, label: v.title }))} value={tab} onChange={setTab} />
      {kind ? <KindPanel key={tab} kind={kind} /> : null}
    </>
  );
}
