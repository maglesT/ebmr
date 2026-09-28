/**
 * ChecklistEntry (module C4): one answer per item from a fixed vocabulary (CONFIRMED / NOT CONFIRMED / NOT
 * APPLICABLE for clearance, YES / NO for equipment status), as large pressable choices. Nothing is
 * pre-selected: every answer is a deliberate choice of the person, and the entry is complete only when every
 * item is answered. What an answer means (e.g. NOT CONFIRMED raising a blocking exception) is decided by the
 * server at commit.
 */
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { fcls } from './classes.ts';
import { ft } from './messages.ts';

export interface ChecklistItem {
  id: string;
  label: string;
}

export interface ChecklistAnswer {
  value: string;
  label: string;
}

export interface ChecklistEntryProps {
  /** Title of the checklist (names the group). */
  label: string;
  items: readonly ChecklistItem[];
  answers: readonly ChecklistAnswer[];
  /** Item id -> chosen answer value; absent means not answered. */
  value: Readonly<Record<string, string>>;
  onChange: (value: Record<string, string>) => void;
  isDisabled?: boolean;
}

/** True when every item has an answer. */
export function checklistComplete(items: readonly ChecklistItem[], value: Readonly<Record<string, string>>): boolean {
  return items.every((i) => typeof value[i.id] === 'string' && value[i.id] !== '');
}

export function ChecklistEntry({ label, items, answers, value, onChange, isDisabled }: ChecklistEntryProps) {
  const open = items.filter((i) => !value[i.id]).length;
  return (
    <div role="group" aria-label={label} className={fcls('checklist')}>
      {items.map((item) => (
        <RadioGroup
          key={item.id}
          className={fcls('checkItem')}
          data-answered={value[item.id] ? 'true' : 'false'}
          orientation="horizontal"
          value={value[item.id] ?? null}
          onChange={(answer) => onChange({ ...value, [item.id]: answer })}
          isDisabled={isDisabled ?? false}
          isRequired
        >
          <Label className={fcls('checkLabel')}>{item.label}</Label>
          <div className={fcls('answers')}>
            {answers.map((a) => (
              <Radio key={a.value} value={a.value} className={fcls('answer')} data-answer={a.value}>
                {a.label}
              </Radio>
            ))}
          </div>
        </RadioGroup>
      ))}
      <p className={fcls('muted')} aria-live="polite">
        {open > 0 ? ft('checklist.unanswered', { count: open, total: items.length }) : null}
      </p>
    </div>
  );
}
