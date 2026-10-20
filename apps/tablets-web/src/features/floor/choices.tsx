/**
 * The identifiers a plant act on the step screen hands to the step's entry forms (Phase 7 slice 7h, WP-A): a room
 * occupied, a unit booked, tooling inspected, issued or returned, a container charged. The act's answer (or an open use
 * the server lists) is chosen for an entry kind; the block's entry form for that kind opens with those members filled
 * and shown, and the person saves it as any entry (their own tapped command). Nothing is typed, nothing is kept once
 * the entry is saved or the screen is left. A printed packaging lot scanned at a G-21 step is chosen with the facts the
 * register holds for it (slice 7h, gap report D2), which the issue entry must carry exactly.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** A chosen member: text as the entry forms take drafts (booleans as YES or NO), or an object member's texts (a lot's facts). */
export type ChosenValue = string | Readonly<Record<string, string>>;

export interface StepChoices {
  /** Members chosen per entry kind. */
  chosen: Readonly<Record<string, Readonly<Record<string, ChosenValue>>>>;
  /** The kind chosen last, and a counter that changes on every choice (the form of that kind opens). */
  last: string | null;
  seq: number;
  choose: (kind: string, values: Readonly<Record<string, ChosenValue>>) => void;
  clear: (kind: string) => void;
}

const Choices = createContext<StepChoices | null>(null);

export function StepChoicesProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Readonly<Record<string, Readonly<Record<string, ChosenValue>>>>>({});
  const [last, setLast] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const choose = useCallback((kind: string, values: Readonly<Record<string, ChosenValue>>) => {
    setChosen((c) => ({ ...c, [kind]: values }));
    setLast(kind);
    setSeq((n) => n + 1);
  }, []);
  const clear = useCallback((kind: string) => {
    setChosen((c) => {
      if (!(kind in c)) return c;
      const { [kind]: _gone, ...rest } = c;
      void _gone;
      return rest;
    });
  }, []);
  const value = useMemo(() => ({ chosen, last, seq, choose, clear }), [chosen, last, seq, choose, clear]);
  return <Choices.Provider value={value}>{children}</Choices.Provider>;
}

/** The step's choices, or null outside a step screen (the forms then take only what their renderer passes). */
export function useStepChoices(): StepChoices | null {
  return useContext(Choices);
}
