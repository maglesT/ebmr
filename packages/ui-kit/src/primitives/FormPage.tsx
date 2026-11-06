/**
 * FormPage (declutter D3): the one form layout of the step screen in every edition. The step reads top to bottom like
 * the paper record: inside it each field of the kit (Field, DecimalField, ChoiceGroup, ScanField) is one row with its
 * label on the left and, to the right, the input, its unit, the description or limits and any error, inline.
 */
import type { ReactNode } from 'react';
import { cls } from './classes.ts';

export interface FormPageProps {
  children: ReactNode;
}

export function FormPage({ children }: FormPageProps) {
  return (
    <div className={cls('formPage')} data-form-page="">
      {children}
    </div>
  );
}
