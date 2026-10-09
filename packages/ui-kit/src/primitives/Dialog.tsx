import type { ReactNode } from 'react';
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { cls } from './classes.ts';

export interface DialogProps {
  title: string;
  isOpen: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Blocking dialogs (lock, NOT SAVED) cannot be dismissed by a click outside or Escape. */
  isDismissable?: boolean;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
}

export function Dialog({ title, isOpen, onOpenChange, isDismissable = true, children, role = 'dialog' }: DialogProps) {
  return (
    <ModalOverlay className={cls('overlay')} isOpen={isOpen} {...(onOpenChange ? { onOpenChange } : {})} isDismissable={isDismissable} isKeyboardDismissDisabled={!isDismissable}>
      <Modal className={cls('modal')}>
        <AriaDialog className={cls('dialog')} role={role}>
          <Heading slot="title" className={cls('dialogTitle')}>
            {title}
          </Heading>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
