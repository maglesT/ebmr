/**
 * StatusOutline (module C4): stages and their steps with the status as colour + icon + word (the words are the
 * server's statusText). The current step is marked for screen readers (aria-current="step"). Pressing a step
 * opens it; whether anything can be done there is the server's answer on that step's screen.
 */
import type { RunView } from '@ebmr/api-contract';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../primitives/Button.tsx';
import { StatusChip } from '../primitives/StatusChip.tsx';
import { fcls } from './classes.ts';
import { enumText, stepTone } from './format.ts';
import { ft } from './messages.ts';

export type OutlineStage = RunView['stages'][number];

export interface StatusOutlineProps {
  stages: readonly OutlineStage[];
  currentStepKey?: string | null;
  onSelect?: (stepKey: string) => void;
  /** Only this stage (e.g. the current one on the step screen); all stages when absent. */
  stageKey?: string | null;
}

export function StatusOutline({ stages, currentStepKey, onSelect, stageKey }: StatusOutlineProps) {
  const shown = stageKey ? stages.filter((s) => s.stageKey === stageKey) : stages;
  return (
    <nav aria-label={ft('outline.title')} className={fcls('outline')}>
      {shown.map((stage) => (
        <section key={stage.stageKey} className={fcls('outlineStage')} aria-label={ft('outline.stage', { number: stage.number, name: stage.name })}>
          <h2 className={fcls('outlineStageTitle')}>
            <span>{ft('outline.stage', { number: stage.number, name: stage.name })}</span>
            <StatusChip tone={stepTone(stage.status)} label={enumText('stage.status', stage.status)} />
          </h2>
          <ol className={fcls('outlineSteps')}>
            {stage.steps.map((step) => (
              <li key={step.stepKey}>
                <Button
                  className={fcls('outlineStep')}
                  onPress={() => onSelect?.(step.stepKey)}
                  {...(step.stepKey === currentStepKey ? { 'aria-current': 'step' as const } : {})}
                  data-testid={`outline-${step.stepKey}`}
                >
                  <span className={fcls('outlineNumber')}>{step.number}</span>
                  <span>{step.title}</span>
                  <StatusChip tone={stepTone(step.status)} label={step.statusText} />
                  {step.openExceptions > 0 ? (
                    <span className={fcls('muted')}>
                      <AlertTriangle aria-hidden="true" size="1em" /> {ft('outline.openExceptions', { count: step.openExceptions })}
                    </span>
                  ) : null}
                </Button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </nav>
  );
}
