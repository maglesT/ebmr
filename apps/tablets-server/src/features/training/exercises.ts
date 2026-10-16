/**
 * Training exercises (Phase 6 slice 6g; D-P6g-0-9): scripted, versioned walk-throughs of the real screens on the
 * sandbox installation. A change to an exercise's steps is a new version; attempts name the version they were made on.
 * Every screen named here is served on the sandbox (test packages, test runs, scales, the audit trail).
 */
export interface TrainingExercise {
  code: string;
  version: number;
  title: string;
  summary: string;
  roles: readonly string[];
  steps: readonly { no: number; instruction: string; screen: string }[];
}

export const EXERCISES: readonly TrainingExercise[] = [
  {
    code: 'EX-FLOOR-RUN',
    version: 1,
    title: 'Run a test batch on the shop floor',
    summary: 'Issue a test batch from a test package, perform its first step and have it verified by a second person.',
    roles: ['BATCH_ISSUER', 'OPERATOR', 'VERIFIER'],
    steps: [
      { no: 1, instruction: 'As the batch issuer, open the test packages and issue a test batch (its number starts with TEST-).', screen: '/packages' },
      { no: 2, instruction: 'As an operator, open the test run and start its first step.', screen: '/runs' },
      { no: 3, instruction: 'Record the step\'s data and sign it as performed.', screen: '/runs' },
      { no: 4, instruction: 'As a verifier (another person), verify the step; note that you cannot verify a step you performed.', screen: '/runs' },
    ],
  },
  {
    code: 'EX-SCALE-WEIGH',
    version: 1,
    title: 'Weigh on a test scale',
    summary: 'Read a weight from a sandbox scale into a dispensing step and see the device reading recorded with it.',
    roles: ['OPERATOR'],
    steps: [
      { no: 1, instruction: 'Open the scales and check that the test scale is online and calibrated.', screen: '/devices/scales' },
      { no: 2, instruction: 'In a test run, open a dispensing step and take the weight from the scale.', screen: '/runs' },
    ],
  },
  {
    code: 'EX-AUDIT-READ',
    version: 1,
    title: 'Read the audit trail of a test run',
    summary: 'Find who did what and when on a test run, and why a corrected value shows both values.',
    roles: ['QA_REVIEWER'],
    steps: [
      { no: 1, instruction: 'Open a finished test run.', screen: '/runs' },
      { no: 2, instruction: 'Open the audit trail and filter it to that run; find the step signatures and any correction with its reason.', screen: '/audit' },
    ],
  },
];

export function exerciseOf(code: string): TrainingExercise | undefined {
  return EXERCISES.find((e) => e.code === code);
}
