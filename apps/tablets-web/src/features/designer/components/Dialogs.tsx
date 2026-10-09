/**
 * The designer's command dialogs (module C2): save a revision with a change note, justify a warning, start
 * verification, send to the sandbox. Each dialog keeps one idempotency key per attempt, so resending after a lost
 * answer never runs the command twice; a refusal is shown in plain language (what happened, why, what to do).
 */
import { useId, useState, type ReactNode } from 'react';
import type { CallError, Result } from '@ebmr/api-contract';
import { Banner, Button, Dialog } from '@ebmr/ui-kit';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { dcls } from '../classes.ts';

const newKey = (): string => crypto.randomUUID();

export interface CommandDialogProps<T> {
  title: string;
  open: boolean;
  onClose: () => void;
  confirmLabel: string;
  canConfirm?: boolean;
  run: (idempotencyKey: string) => Promise<Result<T>>;
  onDone: (value: T) => void;
  children: ReactNode;
}

/** The body lives only while the dialog is open, so each opening starts with a fresh key and no old refusal. */
function CommandBody<T>({ onClose, confirmLabel, canConfirm = true, run, onDone, children }: Omit<CommandDialogProps<T>, 'title' | 'open'>) {
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await run(key);
    setBusy(false);
    if (r.ok) {
      setKey(newKey());
      onDone(r.value);
    } else {
      setError(r.error);
    }
  };
  return (
    <div className={dcls('stack')}>
      {children}
      {error ? <RefusalMessage error={error} /> : null}
      <div className={dcls('inline')}>
        <Button variant="primary" onPress={() => void confirm()} isDisabled={busy || !canConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
        <Button onPress={onClose} isDisabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function CommandDialog<T>({ title, open, ...rest }: CommandDialogProps<T>) {
  return (
    <Dialog title={title} isOpen={open} onOpenChange={(o) => (o ? undefined : rest.onClose())}>
      {open ? <CommandBody {...rest} /> : null}
    </Dialog>
  );
}

/** A labelled multi-line text (change notes and justifications). */
export function NoteField({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max: number }) {
  const id = useId();
  return (
    <div className={dcls('stack')}>
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className={dcls('textarea')} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      <span className={dcls('small')}>
        {value.trim().length} of at most {max} characters
      </span>
    </div>
  );
}

export function ReadOnlyNotice({ state }: { state: string }) {
  return (
    <Banner tone="info" title={`This version is ${state.replace(/_/g, ' ')}: it can no longer be edited.`}>
      A DRAFT is the only state that changes; an approved master changes only through a new, derived version.
    </Banner>
  );
}
