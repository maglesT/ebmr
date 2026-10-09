/**
 * IdentityBanner, full (module C1; plan sections 5 and 9): who is signed in (legal name, user ID, role), on which
 * terminal and room, the installation, and the session actions: Lock, Switch user (kiosks) and Sign out.
 */
import { Button } from '../primitives/Button.tsx';
import { StatusChip } from '../primitives/StatusChip.tsx';
import { icls } from './classes.ts';

export interface IdentityBannerProps {
  productName: string;
  installation: 'GMP' | 'SANDBOX';
  installationLabel: string;
  legalName: string;
  loginName: string;
  role: string;
  deviceCode: string;
  roomCode: string | null;
  kiosk: boolean;
  /** "TAP" or "TAP_PIN" on kiosks: how each entry is confirmed. */
  attribution?: string;
  onLock: () => void;
  onSwitch?: () => void;
  onSignOut: () => void;
}

export function IdentityBanner(p: IdentityBannerProps) {
  return (
    <div className={icls('banner')}>
      <div className={icls('identity')}>
        <span className={icls('product')}>{p.productName}</span>
        <StatusChip tone={p.installation === 'SANDBOX' ? 'test' : 'info'} label={p.installationLabel} />
        <span className={icls('who')} data-testid="identity">
          {`Signed in as ${p.legalName} (${p.loginName}), ${p.role}`}
        </span>
        <span className={icls('muted')}>
          {p.deviceCode}
          {p.roomCode ? ` · room ${p.roomCode}` : ''}
          {p.kiosk ? ` · each entry: ${p.attribution === 'TAP_PIN' ? 'badge and PIN' : 'badge tap'}` : ''}
        </span>
      </div>
      <div className={icls('row')}>
        <Button onPress={p.onLock}>Lock</Button>
        {p.kiosk && p.onSwitch ? <Button onPress={p.onSwitch}>Switch user</Button> : null}
        <Button onPress={p.onSignOut}>Sign out</Button>
      </div>
    </div>
  );
}
