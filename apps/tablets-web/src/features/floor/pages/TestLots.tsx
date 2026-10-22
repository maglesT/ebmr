/**
 * Test lots of the sandbox (Phase 7 slice 7j, R4; D-7j-9): the TEST- lots a test run dispenses from, and, for the
 * master-data steward, the registration of a released, identity-tested TEST- lot of a material, so a master with new
 * materials can be test-run. Sandbox only: the lots are test data and never reach a GMP record (DI-05).
 */
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../../api/hooks.ts';
import { Section } from '../../../app/acts.tsx';
import { DefineForm } from '../../../app/define-form.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';

export function TestLotsPage() {
  const lots = useApiQuery(routes.execution.testLots);
  return (
    <>
      <h1>Test lots</h1>
      <p>TEST- lots for sandbox test runs only; a lot is never changed (register a new one).</p>
      {lots.error ? <RefusalMessage error={lots.error.error} /> : null}
      <Section title="Registered test lots" testId="test-lots">
        <table aria-label="Test lots">
          <thead>
            <tr>
              <th scope="col">Lot</th>
              <th scope="col">Material</th>
              <th scope="col">Status</th>
              <th scope="col">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {lots.data?.lots.map((l) => (
              <tr key={l.lotCode} data-testid={`test-lot-${l.lotCode}`}>
                <td>{l.lotCode}</td>
                <td>
                  {l.material.name} ({l.material.code})
                </td>
                <td>{l.status}</td>
                <td>{l.expiry ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <DefineForm
        title="Register a test lot"
        route={routes.execution.registerTestLot}
        refresh={[routes.execution.testLots.id]}
        submitLabel="Register the test lot"
        fields={[
          { name: 'lotCode', label: 'Lot code', kind: 'text', description: 'TEST- then capitals, digits and dashes' },
          { name: 'materialCode', label: 'Material code', kind: 'text', description: 'As in the master' },
          { name: 'materialName', label: 'Material name', kind: 'text' },
          { name: 'expiresInDays', label: 'Expires in (days)', kind: 'int' },
        ]}
      />
    </>
  );
}
