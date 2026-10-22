/**
 * The product and material masters in effect (Phase 3 slice 6). The ERP is their normal source; since slice 7j (R4,
 * D-7j-1; site-services 1530) the master-data steward may also enter a product or a material on screen (or a new version
 * of one), with its reason. Every version entered here waits for QA's confirmation (ERP_MASTER_CONFIRMED) on the ERP
 * import status screen before anything uses it; the database decides who may enter and who may confirm.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const REFRESH = [routes.quality.erpPending.id, routes.quality.erpProducts.id, routes.quality.erpMaterials.id];
const PHARMACOPOEIAS = ['IP', 'BP', 'PH_EUR', 'USP', 'JP', 'IN_HOUSE', 'NONE'] as const;
const KINDS = ['API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED'] as const;

export function ErpMastersPage() {
  const products = useApiQuery(routes.quality.erpProducts);
  const materials = useApiQuery(routes.quality.erpMaterials);
  const pending = useApiQuery(routes.quality.erpPending);
  const makers = useApiQuery(routes.quality.approvedManufacturers, { query: {} });
  const steward = useOffered('MASTER_ENTRY');
  const approvedOf = (code: string): string[] =>
    (makers.data?.manufacturers ?? []).filter((m) => m.materialCode === code && m.state === 'APPROVED').map((m) => m.manufacturerName);
  return (
    <>
      <h1>Products and materials</h1>
      <p>
        The ERP is the normal source of these masters. A product or material the ERP does not send yet may be entered here;
        every version entered waits for QA&apos;s confirmation on the <Link to="/quality/erp">ERP import status</Link> screen.
      </p>
      {pending.data && pending.data.pending.length > 0 ? (
        <p data-testid="masters-waiting">Waiting for QA confirmation: {pending.data.pending.map((p) => p.key.replace('|', ' ')).join(', ')}</p>
      ) : null}
      <Section title="Products" testId="erp-products">
        {products.error ? <RefusalMessage error={products.error.error} /> : null}
        <table aria-label="Products">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Strength</th>
              <th scope="col">Name</th>
              <th scope="col">Dosage form</th>
              <th scope="col">Shelf life</th>
              <th scope="col">Beta-lactam</th>
              <th scope="col">Reprocessing permitted</th>
            </tr>
          </thead>
          <tbody>
            {products.data?.products.map((p) => (
              <tr key={`${p.productCode}|${p.strength}`}>
                <td>{p.productCode}</td>
                <td>{p.strength}</td>
                <td>{p.productName}</td>
                <td>{p.dosageForm ?? '-'}</td>
                <td>{p.shelfLifeMonths} months</td>
                <td>{p.betaLactam ? 'yes' : 'no'}</td>
                <td>{p.reprocessingPermitted === undefined ? 'not stated' : p.reprocessingPermitted ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Materials" testId="erp-materials">
        {materials.error ? <RefusalMessage error={materials.error.error} /> : null}
        <table aria-label="Materials">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Unit</th>
              <th scope="col">Grade</th>
              <th scope="col">Pharmacopoeia</th>
              <th scope="col">Maximum retest</th>
              <th scope="col">Approved manufacturers</th>
            </tr>
          </thead>
          <tbody>
            {materials.data?.materials.map((m) => (
              <tr key={m.materialCode} data-testid={`material-${m.materialCode}`}>
                <td>{m.materialCode}</td>
                <td>{m.materialName}</td>
                <td>{m.materialKind}</td>
                <td>{m.unit}</td>
                <td>{m.grade ?? '-'}</td>
                <td>{m.pharmacopoeia ?? '-'}</td>
                <td>{m.maxRetestMonths !== undefined ? `${m.maxRetestMonths} months` : '-'}</td>
                <td>
                  {approvedOf(m.materialCode).join(', ') || 'none yet'} (<Link to="/quality/approved-manufacturers">register</Link>)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {steward ? (
        <>
          <DefineForm
            title="Enter a material"
            route={routes.masterData.enterMaterial}
            refresh={REFRESH}
            submitLabel="Enter the material"
            fields={[
              { name: 'materialCode', label: 'Material code', kind: 'text', description: 'Capitals, digits and / . _ -, e.g. RM-DMT-API' },
              { name: 'materialName', label: 'Material name', kind: 'text' },
              { name: 'materialKind', label: 'Kind', kind: 'choice', options: KINDS },
              { name: 'unit', label: 'Stock unit', kind: 'text', description: 'e.g. kg' },
              { name: 'grade', label: 'Grade', kind: 'text', optional: true },
              { name: 'pharmacopoeia', label: 'Pharmacopoeia', kind: 'choice', options: PHARMACOPOEIAS, optional: true },
              { name: 'maxRetestMonths', label: 'Maximum retest interval (months)', kind: 'int', optional: true },
              { name: 'changeReason', label: 'Reason for the entry', kind: 'text' },
            ]}
          />
          <DefineForm
            title="Enter a product"
            route={routes.masterData.enterProduct}
            refresh={REFRESH}
            submitLabel="Enter the product"
            fields={[
              { name: 'productCode', label: 'Product code', kind: 'text', description: 'Capitals, digits and dashes, e.g. DMT400' },
              { name: 'strength', label: 'Strength', kind: 'text', description: 'e.g. 400 mg' },
              { name: 'productName', label: 'Product name', kind: 'text' },
              { name: 'dosageForm', label: 'Dosage form', kind: 'text', description: 'e.g. Film-coated tablet' },
              { name: 'shelfLifeMonths', label: 'Shelf life (months)', kind: 'int' },
              { name: 'betaLactam', label: 'Beta-lactam', kind: 'yesno' },
              { name: 'reprocessingPermitted', label: 'Reprocessing permitted by the registration', kind: 'yesno', optional: true },
              { name: 'changeReason', label: 'Reason for the entry', kind: 'text' },
            ]}
          />
        </>
      ) : null}
    </>
  );
}
