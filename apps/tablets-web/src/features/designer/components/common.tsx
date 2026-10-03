/**
 * Small building blocks of the designer (module C2): state and severity chips (colour + icon + word), fields that
 * commit on blur or Enter (so one edit is one undoable operation), native selects and checkboxes with labels.
 * GMP values go only through DecimalField (text, never a number).
 */
import { useId, useState, type ReactNode } from 'react';
import { ENGINE_ROLES, ROLE_TITLES } from '@ebmr/api-contract';
import { DecimalField, decimalProblem, StatusChip } from '@ebmr/ui-kit';
import { dcls } from '../classes.ts';

const STATE_TONE: Readonly<Record<string, 'ok' | 'warning' | 'error' | 'info' | 'neutral' | 'pending'>> = {
  DRAFT: 'neutral',
  IN_VERIFICATION: 'pending',
  SUBMITTED: 'info',
  CHECKED: 'info',
  APPROVED: 'ok',
  RETIRED: 'neutral',
  WITHDRAWN: 'error',
};

export function StateChip({ state }: { state: string }) {
  return <StatusChip tone={STATE_TONE[state] ?? 'neutral'} label={state.replace(/_/g, ' ')} />;
}

export function SeverityChip({ severity }: { severity: 'ERROR' | 'WARNING' | 'INFO' }) {
  return <StatusChip tone={severity === 'ERROR' ? 'error' : severity === 'WARNING' ? 'warning' : 'info'} label={severity === 'ERROR' ? 'Error' : severity === 'WARNING' ? 'Warning' : 'Information'} />;
}

const ENGINE: ReadonlySet<string> = new Set(ENGINE_ROLES);

/**
 * The title of a role an MBR names. Only engine roles have a title here: a master names engine roles, and a kernel
 * role such as QA_SHOP_FLOOR (titled like the engine role QA elsewhere) or any other code is shown as written, marked
 * as no engine role, so a master naming it never reads like a correct one (review F49).
 */
export const roleTitle = (role: string | undefined): string => {
  if (!role) return '—';
  return ENGINE.has(role) ? (ROLE_TITLES[role] ?? role) : `${role} (not an engine role: no one can act in it)`;
};

/** The comparison of a limit bound in words: whether the bound value itself passes (at least / at most) or fails. */
export function comparisonWords(side: 'low' | 'high', inclusive: boolean): string {
  if (side === 'low') return inclusive ? 'at least' : 'more than';
  return inclusive ? 'at most' : 'less than';
}

/** One limit bound in words with its exact value as written, e.g. "less than 3.5 %"; never rounded (review F47). */
export function boundWords(side: 'low' | 'high', bound: { value: string; inclusive: boolean } | undefined, unit: string): string {
  if (!bound) return side === 'low' ? 'no lower limit' : 'no upper limit';
  return `${comparisonWords(side, bound.inclusive)} ${bound.value}${unit ? ` ${unit}` : ''}`;
}

/** A decimal that commits a complete value on blur or Enter; empty commits null (removes the value). */
export function CommitDecimal({
  label,
  unit,
  value,
  onCommit,
  readOnly,
  allowEmpty = true,
  maxDecimals,
}: {
  label: string;
  unit: string;
  value: string | undefined;
  onCommit: (value: string | null) => void;
  readOnly?: boolean;
  allowEmpty?: boolean;
  maxDecimals?: number;
}) {
  const [text, setText] = useState(value ?? '');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The committed value changed (undo, a server answer): start again from it (derived state, set during render).
  const [base, setBase] = useState(value);
  if (base !== value) {
    setBase(value);
    setText(value ?? '');
    setProblem(undefined);
  }
  if (readOnly) {
    return (
      <span>
        {value ?? '—'} {value ? unit : ''}
      </span>
    );
  }
  const commit = (): void => {
    if (text === (value ?? '')) return;
    if (text === '') {
      if (!allowEmpty) {
        setProblem('A value is required.');
        return;
      }
      setProblem(undefined);
      onCommit(null);
      return;
    }
    const p = decimalProblem(text, maxDecimals !== undefined ? { maxDecimals } : {});
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(undefined);
    onCommit(text);
  };
  return (
    <div
      className={dcls('limitCell')}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    >
      <DecimalField label={label} unit={unit} value={text} onChange={setText} {...(problem ? { errorMessage: problem } : {})} {...(maxDecimals !== undefined ? { maxDecimals } : {})} />
    </div>
  );
}

/**
 * Why a typed whole number is not taken, or null (review F53; PR-03, PR-29): digits only (no spaces, signs, separators,
 * decimals or leading zeros), a safe integer, within the schema's range.
 */
export function integerProblem(text: string, min?: number, max?: number): string | null {
  const range = min !== undefined && max !== undefined ? ` from ${min} to ${max}` : min !== undefined ? ` of at least ${min}` : max !== undefined ? ` of at most ${max}` : '';
  const ask = `Enter a whole number${range}, in digits only.`;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return ask;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) return ask;
  return null;
}

/**
 * A whole number that commits on blur or Enter (review F53). Text that is not a whole number within the range is
 * refused in words under the field and nothing is committed, so the field never shows a value the configuration does
 * not hold without saying so; empty commits null (removes the value) only where the value may be absent.
 */
export function CommitInteger({
  label,
  value,
  onCommit,
  readOnly,
  allowEmpty,
  min,
  max,
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | null) => void;
  readOnly?: boolean;
  allowEmpty: boolean;
  min?: number;
  max?: number;
}) {
  const id = useId();
  const errorId = useId();
  const shown = value === undefined ? '' : String(value);
  const [text, setText] = useState(shown);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The committed value changed (undo, a server answer): start again from it (derived state, set during render).
  const [base, setBase] = useState(shown);
  if (base !== shown) {
    setBase(shown);
    setText(shown);
    setProblem(undefined);
  }
  const commit = (): void => {
    if (text === shown) {
      setProblem(undefined);
      return;
    }
    if (text === '') {
      if (!allowEmpty) {
        setProblem('A value is required.');
        return;
      }
      setProblem(undefined);
      onCommit(null);
      return;
    }
    const p = integerProblem(text, min, max);
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(undefined);
    onCommit(Number(text));
  };
  return (
    <div className={dcls('stack')}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={dcls('select')}
        inputMode="numeric"
        autoComplete="off"
        value={text}
        readOnly={readOnly ?? false}
        aria-invalid={problem !== undefined}
        {...(problem !== undefined ? { 'aria-describedby': errorId } : {})}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {problem !== undefined ? (
        <p id={errorId} role="alert" className={dcls('fieldError')}>
          {problem} The configuration keeps {shown === '' ? 'no value' : shown}.
        </p>
      ) : null}
    </div>
  );
}

/** A text input that commits on blur or Enter. */
export function CommitText({ label, value, onCommit, readOnly, multiline }: { label: string; value: string; onCommit: (value: string) => void; readOnly?: boolean; multiline?: boolean }) {
  const id = useId();
  const [text, setText] = useState(value);
  const [base, setBase] = useState(value);
  if (base !== value) {
    setBase(value);
    setText(value);
  }
  const commit = (): void => {
    if (text !== value) onCommit(text);
  };
  return (
    <div className={dcls('stack')}>
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} className={dcls('textarea')} value={text} readOnly={readOnly ?? false} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <input
          id={id}
          className={dcls('select')}
          value={text}
          readOnly={readOnly ?? false}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      )}
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
}

/**
 * A native select. A value that is none of the options (content saved through the API) is shown as it is, marked, never
 * replaced on screen by the first option (review F49).
 */
export function Select({ label, value, options, onChange, disabled }: { label: string; value: string; options: readonly Option[]; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  const shown = options.some((o) => o.value === value) ? options : [{ value, label: `${value || '(none)'}: not one of the choices` }, ...options];
  return (
    <div className={dcls('stack')}>
      <label htmlFor={id}>{label}</label>
      <select id={id} className={dcls('select')} value={value} disabled={disabled ?? false} onChange={(e) => onChange(e.target.value)}>
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Check({ label, checked, onChange, disabled, description }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; description?: string }) {
  const id = useId();
  return (
    <div className={dcls('checkbox')}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled ?? false} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        {label}
        {description ? <span className={dcls('small')}> · {description}</span> : null}
      </label>
    </div>
  );
}

/** A group of checkboxes over items; `selected` is kept in the items' order. */
export function CheckList({ legend, items, selected, onChange, disabled }: { legend: string; items: readonly Option[]; selected: readonly string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  if (items.length === 0) return null;
  return (
    <fieldset className={dcls('fieldset')}>
      <legend className={dcls('legend')}>{legend}</legend>
      {items.map((i) => (
        <Check
          key={i.value}
          label={i.label}
          checked={selected.includes(i.value)}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(on) => onChange(items.map((x) => x.value).filter((v) => (v === i.value ? on : selected.includes(v))))}
        />
      ))}
    </fieldset>
  );
}

export const shortHash = (h: string): string => `${h.slice(0, 12)}…`;
