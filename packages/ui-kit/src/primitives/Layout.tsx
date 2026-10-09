import type { ReactNode } from 'react';
import { cls } from './classes.ts';

export interface LayoutProps {
  /** Above the header: the watermark band on the sandbox. */
  top?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
}

export function Layout({ top, header, children }: LayoutProps) {
  return (
    <div className={cls('layout')}>
      {top}
      {header ? <header className={cls('layoutHeader')}>{header}</header> : null}
      <main className={cls('layoutMain')} id="main">
        {children}
      </main>
    </div>
  );
}
