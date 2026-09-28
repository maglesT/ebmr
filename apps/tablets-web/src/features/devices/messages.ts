/** English texts of the devices feature (module C5); i18next and Hindi arrive in A2. */
export const DEVICES_EN = {
  'gauge.label': 'Live weight on {device}',
  'gauge.notRecorded': 'live, not recorded',
  'gauge.stable': 'Stable',
  'gauge.settling': 'Settling',
  'gauge.overload': 'Overload',
  'gauge.underload': 'Underload',
  'gauge.offline': 'Scale offline',
  'gauge.error': 'Scale error',
  'gauge.waiting': 'Waiting for the scale…',
  'gauge.band': 'Range {low} to {high} {unit}',
  'gauge.target': 'Target {target} {unit}',
  'gauge.in': 'Inside the range (display only; the entry is judged when it is saved)',
  'gauge.below': 'Below the range (display only; the entry is judged when it is saved)',
  'gauge.above': 'Above the range (display only; the entry is judged when it is saved)',
  'capture.TARE': 'Capture tare',
  'capture.GROSS': 'Capture gross',
  'capture.CHECK': 'Capture check weight',
  'capture.busy': 'Waiting for a stable weight…',
  'capture.done': 'Captured {value} {unit} from {device}',
  'slot.checking': 'Checking the scale…',
  'slot.offline': 'Scale offline: manual entry needs a second person',
  'slot.offlineWhy': '{device} has not reported to the site gateway in the last 10 seconds, or it is not the registered instrument. Enter the weights by hand; a second person must then verify the step.',
  'slot.noScale': 'No scale of this room is available for this step',
  'slot.noScaleWhy': 'Enter the weights by hand; a second person must then verify the step.',
  'scales.title': 'Scales',
  'scales.intro': 'The scales of this terminal’s room, as the site gateway reports them. A check weight is kept in the scale log; it is not part of any batch record.',
  'scales.none': 'No scale is registered to this room.',
  'scales.last': 'Last check weight',
  'scales.value': 'Weight',
  'scales.device': 'Scale',
  'scales.gateway': 'Gateway',
  'scales.raw': 'Raw line from the scale',
  'scales.source': 'Scale time (not synchronised)',
  'scales.sourceSynced': 'Scale time (synchronised)',
  'scales.recorded': 'Recorded by the server',
  'scales.status.ONLINE': 'Online',
  'scales.status.OFFLINE': 'Offline',
  'scales.status.UNKNOWN': 'Not reporting yet',
  'tile.title': 'Scales',
  'tile.description': 'Live weight and a check weight from the scales of this room.',
} as const;

export type DevicesMessageKey = keyof typeof DEVICES_EN;

export function dt(key: DevicesMessageKey, params: Readonly<Record<string, string>> = {}): string {
  return DEVICES_EN[key].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);
}
