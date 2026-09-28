/**
 * DecimalField (plan section 3): the only numeric input for GMP values. It works on text end to end: the value
 * is a DecimalString (never a JavaScript number, never exponent form), the unit is fixed and shown, the field is
 * never pre-filled, and a complete value is echoed back ("You entered 12.503 kg") before the person commits.
 * react-aria's NumberField is lint-banned because it produces numbers.
 */
import { DECIMAL_PATTERN } from '@ebmr/api-contract';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { t } from '../i18n/index.ts';
import { cls } from './classes.ts';

export interface DecimalRules {
  maxDecimals?: number;
  allowNegative?: boolean;
}

/** Characters a decimal may contain while it is typed. */
const TYPING = /^-?[0-9]*\.?[0-9]*$/;

/** Why a text is not a complete decimal under the rules, or null when it is one. */
export function decimalProblem(text: string, rules: DecimalRules = {}): string | null {
  if (!DECIMAL_PATTERN.test(text) || (!rules.allowNegative && text.startsWith('-'))) return t('decimal.invalid');
  const decimals = text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
  if (rules.maxDecimals !== undefined && decimals > rules.maxDecimals) return t('decimal.tooManyDecimals', { digits: rules.maxDecimals });
  return null;
}

/** Keeps only what a person can be typing towards a decimal; anything else is not accepted into the field. */
export function acceptTyping(previous: string, next: string, rules: DecimalRules = {}): string {
  if (next === '') return '';
  if (!TYPING.test(next)) return previous;
  if (!rules.allowNegative && next.startsWith('-')) return previous;
  return next;
}

export interface DecimalFieldProps extends DecimalRules {
  label: string;
  /** The fixed unit of the value (UCUM code as shown, e.g. kg). */
  unit: string;
  /** The current text; start from '' (never pre-filled). */
  value: string;
  onChange: (value: string) => void;
  name?: string;
  description?: string;
  /** A refusal or problem from the server, shown under the field. */
  errorMessage?: string;
  isDisabled?: boolean;
  autoFocus?: boolean;
}

export function DecimalField({ label, unit, value, onChange, name, description, errorMessage, isDisabled, autoFocus, maxDecimals, allowNegative }: DecimalFieldProps) {
  const rules: DecimalRules = { ...(maxDecimals !== undefined ? { maxDecimals } : {}), ...(allowNegative !== undefined ? { allowNegative } : {}) };
  const problem = value === '' ? null : decimalProblem(value, rules);
  const shownError = errorMessage ?? (problem && !/^-?[0-9]*\.$/.test(value) ? problem : undefined);
  return (
    <TextField
      className={cls('field')}
      value={value}
      onChange={(next) => onChange(acceptTyping(value, next, rules))}
      {...(name ? { name } : {})}
      isDisabled={isDisabled ?? false}
      isInvalid={shownError !== undefined}
      {...(autoFocus ? { autoFocus } : {})}
    >
      <Label className={cls('label')}>{label}</Label>
      <div className={cls('unitRow')}>
        <Input className={`${cls('input')} ${cls('value')}`} inputMode="decimal" autoComplete="off" spellCheck={false} aria-describedby={undefined} />
        <span className={cls('unit')} aria-hidden="true">
          {unit}
        </span>
      </div>
      {description ? (
        <Text slot="description" className={cls('description')}>
          {description}
        </Text>
      ) : null}
      {value !== '' && problem === null ? (
        <Text slot="description" className={cls('echo')} aria-live="polite">
          {t('decimal.echo', { value, unit })}
        </Text>
      ) : null}
      <FieldError className={cls('error')}>{shownError}</FieldError>
    </TextField>
  );
}
