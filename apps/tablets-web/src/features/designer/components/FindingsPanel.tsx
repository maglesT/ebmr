/**
 * Findings of the server validation (module C2; plan section 8), grouped by document section, each with its rule,
 * controls and plain message, a "go to" that jumps to the place in the document, and for warnings the recorded
 * justification or a Justify action (outline 6.3: warnings need a recorded justification; errors must be fixed).
 */
import type { CallError } from '@ebmr/api-contract';
import { Banner, Button, StatusChip } from '@ebmr/ui-kit';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { dcls } from '../classes.ts';
import { DOCUMENT_SECTIONS } from '../model/sections.ts';
import type { FindingItem, ValidationData } from '../model/types.ts';
import { SeverityChip } from './common.tsx';

export interface FindingsPanelProps {
  report: ValidationData | null;
  pending: boolean;
  error: CallError | null;
  /** Why justifying is not possible now (unsaved changes, not a DRAFT), or null. */
  justifyBlocked: string | null;
  onJump: (f: FindingItem) => void;
  onJustify: (f: FindingItem) => void;
  locationLabel: (f: FindingItem) => string;
}

export function gateSummary(report: ValidationData): string {
  const g = report.gate;
  if (g.passed) return g.warnings > 0 ? `Passed: no errors; ${g.warnings} warnings, all justified` : 'Passed: no errors, no warnings';
  return `${g.errors} errors, ${g.warnings} warnings (${g.unjustifiedWarnings} without a justification)`;
}

export function FindingsPanel({ report, pending, error, justifyBlocked, onJump, onJustify, locationLabel }: FindingsPanelProps) {
  if (error) return <RefusalMessage error={error} />;
  if (!report) return <p aria-live="polite">Checking…</p>;
  const bySection = DOCUMENT_SECTIONS.map((s) => ({ ...s, findings: report.findings.filter((f) => f.section === s.id) })).filter((s) => s.findings.length > 0);
  return (
    <div aria-live="polite" aria-busy={pending}>
      <div className={dcls('inline')}>
        <StatusChip tone={report.gate.passed ? 'ok' : report.gate.errors > 0 ? 'error' : 'warning'} label={gateSummary(report)} />
        {pending ? <span className={dcls('small')}>checking the latest change…</span> : null}
      </div>
      {bySection.length === 0 ? <Banner tone="ok" title="No findings." /> : null}
      {bySection.map((s) => (
        <section key={s.id} aria-label={`Findings in section ${s.id} ${s.title}`}>
          <h4 className={dcls('findingGroup')}>
            {s.id} {s.title} ({s.findings.length})
          </h4>
          {s.findings.map((f) => (
            <article key={f.key} className={dcls('finding')} data-finding-key={f.key}>
              <div className={dcls('inline')}>
                <SeverityChip severity={f.severity} />
                <span className={dcls('mono')}>{f.rule}</span>
                <span className={dcls('small')}>{f.controls.join(', ')}</span>
              </div>
              <p>{f.message}</p>
              <div className={dcls('inline')}>
                <Button variant="quiet" onPress={() => onJump(f)} aria-label={`Go to ${locationLabel(f)} for ${f.rule}`}>
                  Go to {locationLabel(f)}
                </Button>
                {f.severity === 'WARNING' && !f.justification ? (
                  <Button onPress={() => onJustify(f)} isDisabled={justifyBlocked !== null} aria-label={`Justify ${f.key}`}>
                    Justify
                  </Button>
                ) : null}
              </div>
              {f.severity === 'WARNING' && !f.justification && justifyBlocked ? <p className={dcls('small')}>{justifyBlocked}</p> : null}
              {f.justification ? (
                <p className={dcls('small')}>
                  Justified by {f.justification.by.legalName} ({f.justification.by.loginName}) on {f.justification.at.text}: “{f.justification.text}”
                </p>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
