/** The ERP product and material masters as the ERP stub sent them (Phase 3 slice 6): read only, changed in the ERP. */
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

export function ErpMastersPage() {
  const products = useApiQuery(routes.quality.erpProducts);
  const materials = useApiQuery(routes.quality.erpMaterials);
  return (
    <>
      <h1>ERP products and materials</h1>
      <p>Read only: these masters come from the ERP and are changed there.</p>
      <Section title="Products" testId="erp-products">
        {products.error ? <RefusalMessage error={products.error.error} /> : null}
        <table aria-label="Products">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Strength</th>
              <th scope="col">Name</th>
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
              <th scope="col">Maximum retest</th>
            </tr>
          </thead>
          <tbody>
            {materials.data?.materials.map((m) => (
              <tr key={m.materialCode}>
                <td>{m.materialCode}</td>
                <td>{m.materialName}</td>
                <td>{m.materialKind}</td>
                <td>{m.unit}</td>
                <td>{m.maxRetestMonths !== undefined ? `${m.maxRetestMonths} months` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
