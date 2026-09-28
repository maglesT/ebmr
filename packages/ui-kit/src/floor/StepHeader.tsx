/**
 * StepHeader (module C4): "Step 2.1.4 of 13 · Blend", the status as colour + icon + word, the block, and the
 * instruction exactly as issued with its SOP reference (code, version, title).
 */
import type { StepScreenView } from '@ebmr/api-contract';
import { StatusChip } from '../primitives/StatusChip.tsx';
import { fcls } from './classes.ts';
import { stepTone } from './format.ts';
import { ft } from './messages.ts';

export interface StepHeaderProps {
  step: StepScreenView['step'];
}

export function StepHeader({ step }: StepHeaderProps) {
  const sop = step.instruction.sop;
  return (
    <header className={fcls('stepHeader')}>
      <div className={fcls('stepLine')}>
        <h1 className={fcls('stepTitle')}>
          {ft('step.of', { number: step.number, of: step.of })} · {step.title}
        </h1>
        <StatusChip tone={stepTone(step.status)} label={step.statusText} />
        {step.blockTitle ? (
          <span className={fcls('muted')}>
            {step.blockTitle}
            {step.block ? ` (${step.block})` : ''}
          </span>
        ) : null}
      </div>
      <p className={fcls('instruction')} data-testid="instruction">
        {step.instruction.text}
      </p>
      <p className={fcls('sop')}>{sop ? ft('step.sop', { code: sop.code, version: sop.version, title: sop.title }) : ft('step.noSop')}</p>
    </header>
  );
}
