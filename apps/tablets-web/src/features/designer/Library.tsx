/**
 * Master records library (module C2; plan section 12, screen 4): families and their versions with state chips, and the
 * reference documents an MBR may cite (slice 7g-5).
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { dcls } from './classes.ts';
import { StateChip } from './components/common.tsx';
import { ReferenceDocuments } from './ReferenceDocuments.tsx';

export function Library() {
  const families = useApiQuery(routes.designer.families);
  return (
    <div className={dcls('page')}>
      <h1>Master records</h1>
      <p>
        <Link to="/mbr/new">New master record from a template</Link>
      </p>
      {families.error ? <RefusalMessage error={families.error.error} /> : null}
      {!families.data ? (
        families.error ? null : <p>Loading…</p>
      ) : families.data.families.length === 0 ? (
        <Banner tone="info" title="No master records yet.">
          Start one from a template.
        </Banner>
      ) : (
        <table className={dcls('grid')} aria-label="MBR families and versions">
          <thead>
            <tr>
              <th scope="col">Family</th>
              <th scope="col">Product</th>
              <th scope="col">Markets</th>
              <th scope="col">Versions</th>
            </tr>
          </thead>
          <tbody>
            {families.data.families.map((f) => (
              <tr key={f.familyId}>
                <td className={dcls('mono')}>{f.familyCode}</td>
                <td>
                  {f.product.name} {f.product.strength} <span className={dcls('small')}>({f.product.code})</span>
                </td>
                <td>{f.markets.join(', ')}</td>
                <td>
                  <ul className={dcls('list')} style={{ listStyle: 'none', padding: 0 }}>
                    {f.versions.map((v) => (
                      <li key={v.versionId} className={dcls('inline')}>
                        <Link to="/mbr/versions/$versionId" params={{ versionId: v.versionId }} aria-label={`Open ${f.familyCode} version ${v.number}`}>
                          Version {v.number}
                        </Link>
                        <StateChip state={v.state} />
                        <span className={dcls('small')}>
                          revision {v.revision}, saved {v.savedAt.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReferenceDocuments />
    </div>
  );
}
