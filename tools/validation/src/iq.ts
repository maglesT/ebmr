/**
 * The installation qualification of the CLI (`pnpm validation:iq`): the code lives in the validation kit since slice 7g-3
 * (decision D-P7R-5), so the server's IQ route and this CLI run the same checks.
 */
export { runIq, type IqCheckResult, type IqInputs, type IqRecord } from '@ebmr/validation-kit';
