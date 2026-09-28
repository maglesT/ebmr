/**
 * PrimaryActionBar (module C4): one primary action at the bottom of the step card (80 px at floor density)
 * and a "More" menu for everything else. What is available, and why not, is the server's answer (its dry run
 * of the engine): an unavailable action stays visible, greyed, with the server's reason in words.
 */
import { Menu, MenuItem, MenuTrigger, Popover, Text } from 'react-aria-components';
import { Button } from '../primitives/Button.tsx';
import { fcls } from './classes.ts';
import { ft } from './messages.ts';

export interface BarAction {
  id: string;
  label: string;
  isDisabled: boolean;
  /** Why it is not available (the server's reason), or a hint. */
  reason: string | null;
}

export interface PrimaryActionBarProps {
  primary: BarAction | null;
  onPrimary?: () => void;
  /** Shown instead of a primary button (e.g. "Record the values above"). */
  hint?: string;
  more: readonly BarAction[];
  onMore: (id: string) => void;
  /** True while a command is being sent: every action waits. */
  busy?: boolean;
}

export function PrimaryActionBar({ primary, onPrimary, hint, more, onMore, busy }: PrimaryActionBarProps) {
  const waiting = busy ?? false;
  return (
    <div className={fcls('actionBar')} role="region" aria-label="Step actions" data-testid="action-bar">
      <div className={fcls('barMain')}>
        {primary ? (
          <>
            <Button variant="primary" className={fcls('primary')} onPress={() => onPrimary?.()} isDisabled={primary.isDisabled || waiting} data-testid="primary-action">
              {primary.label}
            </Button>
            {primary.isDisabled && primary.reason ? (
              <p className={fcls('barReason')} data-testid="primary-reason">
                {ft('action.notAvailable')}: {primary.reason}
              </p>
            ) : null}
          </>
        ) : hint ? (
          <p className={fcls('barReason')}>{hint}</p>
        ) : null}
      </div>
      {more.length > 0 ? (
        <MenuTrigger>
          <Button className={fcls('more')} isDisabled={waiting} aria-label={ft('action.moreTitle')}>
            {ft('action.more')} …
          </Button>
          <Popover className={fcls('menuPopover')} placement="top end">
            <Menu
              className={fcls('menu')}
              aria-label={ft('action.moreTitle')}
              disabledKeys={more.filter((a) => a.isDisabled).map((a) => a.id)}
              onAction={(key) => onMore(String(key))}
            >
              {more.map((a) => (
                <MenuItem key={a.id} id={a.id} textValue={a.label} className={fcls('menuItem')}>
                  <Text slot="label" className={fcls('menuLabel')}>
                    {a.label}
                  </Text>
                  {a.reason ? (
                    <Text slot="description" className={fcls('menuReason')}>
                      {a.isDisabled ? `${ft('action.notAvailable')}: ${a.reason}` : a.reason}
                    </Text>
                  ) : null}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      ) : null}
    </div>
  );
}
