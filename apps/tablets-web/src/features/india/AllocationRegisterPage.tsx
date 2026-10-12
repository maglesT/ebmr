/**
 * The batch-number allocation register (Phase 4 slice 6a; IN-18): every number allocated at the session's site, voided
 * ones included, with its allocation date, product, batch size and its use, as the server exports it for an inspector.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { words } from './reads.ts';

export function AllocationRegisterPage() {
  const q = useApiQuery(routes.india.allocationRegister, { query: {} });
  return (
    <>
      <h1>Batch-number allocation register</h1>
      <p>A number is allocated once, ever: a voided or cancelled number stays in the register and is never offered again.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.entries.length === 0 ? <p>No number is allocated at {q.data.siteCode}.</p> : null}
      {q.data && q.data.entries.length > 0 ? (
        <table data-testid="allocation-register">
          <thead>
            <tr>
              <th scope="col">Batch number</th>
              <th scope="col">Allocated</th>
              <th scope="col">Product</th>
              <th scope="col">Batch size</th>
              <th scope="col">Kind</th>
              <th scope="col">Use</th>
              <th scope="col">Licence</th>
            </tr>
          </thead>
          <tbody>
            {q.data.entries.map((e) => (
              <tr key={e.allocationId} data-testid={`allocation-${e.batchNumber}`} data-use={e.use}>
                <td>{e.batchId ? <Link to="/india/batches/$batchId" params={{ batchId: e.batchId }}>{e.batchNumber}</Link> : e.batchNumber}</td>
                <td>{e.allocationDate}</td>
                <td>
                  {e.productCode} {e.strength ?? ''} ({e.productName})
                </td>
                <td>
                  {e.batchSize} {e.batchSizeUnit}
                </td>
                <td>
                  {words(e.kind)}
                  {e.parentBatchNumber ? ` of ${e.parentBatchNumber}` : ''}
                </td>
                <td>
                  {words(e.use)}
                  {e.voidReason ? `: ${e.voidReason}` : ''}
                </td>
                <td>
                  {e.licenceNumber ?? ''}
                  {e.loanLicenceNumber ? ` / loan ${e.loanLicenceNumber}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
