/** Accessible tables (react-aria-components) with the kit's styling. */
import { clsx } from 'clsx';
import { Cell, Column, Row, Table as AriaTable, TableBody, TableHeader, type TableProps } from 'react-aria-components';
import { cls } from './classes.ts';

export function Table({ className, ...props }: TableProps & { className?: string }) {
  return <AriaTable {...props} className={clsx(cls('table'), className)} />;
}

export { Cell, Column, Row, TableBody, TableHeader };
