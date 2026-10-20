/**
 * The demo device picker's list (DEMO-ONLY; demo installations only). Phase 7 slice 7i (G1, hosted demo of 20 October
 * 2026): a kiosk's demo badge reader offered only the persons whose home terminal is that kiosk, so a presenter could not
 * sign the floor people in on KIOSK-BLEND-1, KIOSK-COMP-1 or KIOSK-PACK-1 (a badge UID cannot be typed or pasted, on
 * purpose: BADGE-AUTOFILL). Each shop-floor terminal now also lists every other demo person of the installation who has
 * a badge (`otherPersonas`, "Other people"), after its own ("Works here"). This is a convenience of the demo reader only:
 * the server still decides at sign-in whether the person may work on that terminal, in that room, for that act.
 */
import type { DemoDeviceView, DemoPersonaView } from '@ebmr/api-contract';
import { isShopFloor } from '../../platform/auth/session.ts';

export function demoDevicesView(devices: readonly DemoDeviceView[]): DemoDeviceView[] {
  const badged = new Map<string, DemoPersonaView>();
  for (const d of devices) for (const p of d.personas) if (p.badgeUid && !badged.has(p.loginName)) badged.set(p.loginName, p);
  const everyone = [...badged.values()].sort((a, b) => a.legalName.localeCompare(b.legalName, 'en'));
  return devices.map((d) => {
    if (!isShopFloor(d.deviceClass)) return d;
    const here = new Set(d.personas.map((p) => p.loginName));
    return { ...d, otherPersonas: everyone.filter((p) => !here.has(p.loginName)) };
  });
}
