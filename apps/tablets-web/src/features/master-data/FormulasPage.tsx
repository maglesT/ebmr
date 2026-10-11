/**
 * The company formulation library (Phase 3 slice 6, decision 0006 part 1, D-S6-3): formulas by product, strength and
 * batch size, with their version states. The list shows identities only (no composition). Recording a formula needs
 * FORMULA.MANAGE (the server decides).
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

export function FormulasPage() {
  const formulas = useApiQuery(routes.masterData.formulas);
  const author = useOffered('FORMULA_AUTHOR');
  return (
    <>
      <h1>Formulas</h1>
      {formulas.error ? <RefusalMessage error={formulas.error.error} /> : null}
      <table aria-label="Formulas">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Strength</th>
            <th scope="col">Batch size (units)</th>
            <th scope="col">Latest version</th>
            <th scope="col">Approved version</th>
          </tr>
        </thead>
        <tbody>
          {formulas.data?.formulas.map((f) => (
            <tr key={f.formulaId} data-testid={`formula-${f.productCode}-${f.strength}`}>
              <td>
                <Link to="/master-data/formulas/$formulaId" params={{ formulaId: f.formulaId }}>
                  {f.productName ?? f.productCode} ({f.productCode})
                </Link>
              </td>
              <td>{f.strength}</td>
              <td>{f.batchSizeUnits}</td>
              <td>{f.latestVersion}</td>
              <td>{f.approvedVersion ?? 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {author ? (
        <DefineForm
          title="Record a formula"
          route={routes.masterData.createFormula}
          refresh={[routes.masterData.formulas.id]}
          submitLabel="Record the formula"
          fields={[
            { name: 'productCode', label: 'Product code', kind: 'text', description: 'From the ERP product master' },
            { name: 'strength', label: 'Strength', kind: 'text' },
            { name: 'batchSizeUnits', label: 'Batch size (tablets)', kind: 'text', description: 'A whole number of units' },
          ]}
        />
      ) : null}
    </>
  );
}
