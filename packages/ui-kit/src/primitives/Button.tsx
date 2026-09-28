import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cls } from './classes.ts';

export interface ButtonProps extends Omit<AriaButtonProps, 'children' | 'className'> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  className?: string;
}

/** A button with the density's minimum target size (floor: 56 px). */
export function Button({ children, variant = 'secondary', className, ...rest }: ButtonProps) {
  return (
    <AriaButton {...rest} data-variant={variant} className={clsx(cls('button'), className)}>
      {children}
    </AriaButton>
  );
}
