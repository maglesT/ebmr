/**
 * The DEMO-ONLY badges a demo terminal's badge reader offers (demo installations only). Phase 7 slice 7i (G1): those who
 * work here first, then every other badge holder of the installation (the server lists them as `otherPersonas` on a
 * kiosk), so a presenter can sign anyone in on any kiosk. The server still decides whether that person may work there.
 */
import type { DemoDeviceView } from '@ebmr/api-contract';
import type { identity } from '@ebmr/ui-kit';

export function demoBadgesOf(device: DemoDeviceView | null | undefined): identity.DemoBadge[] {
  if (!device) return [];
  const here = device.personas.flatMap((p) => (p.badgeUid ? [{ legalName: p.legalName, badgeUid: p.badgeUid, worksHere: true }] : []));
  const seen = new Set(here.map((b) => b.badgeUid));
  const others = (device.otherPersonas ?? []).flatMap((p) => (p.badgeUid && !seen.has(p.badgeUid) ? [{ legalName: p.legalName, badgeUid: p.badgeUid, worksHere: false }] : []));
  return [...here, ...others];
}
