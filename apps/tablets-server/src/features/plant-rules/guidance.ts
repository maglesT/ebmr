/**
 * Guidance for the plant rule codes of slice 6b (recipe-core 0973 to 0975, kernel 1190, site services 0940): what a
 * person sees when the database refuses a step start, a signature, a receipt or a reagent, and what to do next.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const entry = (whatHappened: string, whatYouCanDo: string[], whoCanHelp: string[], controls: string[], kind: GuidanceEntry['kind'] = 'NOT_ALLOWED'): GuidanceEntry => ({
  status: 422, kind, whatHappened, whatYouCanDo, whoCanHelp, controls,
});

export const PLANT_RULES_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-PLANT-150': entry('The room is overdue for cleaning: its last verified cleaning is older than its clean-hold time.', ['Have the room cleaned and the cleaning verified, then clear it and start again.'], ['Housekeeping', 'The shift supervisor'], ['PR-25']),
  'EBMR-PLANT-151': entry('A spill was recorded in this room: it needs cleaning before work starts there again.', ['Have the room cleaned and the cleaning verified by a second person.'], ['Housekeeping', 'The shift supervisor'], ['PR-27']),
  'EBMR-PLANT-152': entry('A spill is recorded by a person, with what was spilt.', ['Describe the spill and record it again.'], ['The shift supervisor'], ['PR-27'], 'INVALID_INPUT'),
  'EBMR-PLANT-153': entry('The rules of a room need the controlled-area flag, the clean-hold time (or none) and the reason.', ['Complete the form and save again.'], ['The master data steward'], ['PR-15', 'PR-25'], 'INVALID_INPUT'),
  'EBMR-PLANT-160': entry('An adjacency names two different rooms or lines; a segregation states its justification.', ['Complete the form and save again.'], ['The master data steward'], ['PR-35'], 'INVALID_INPUT'),
  'EBMR-PLANT-161': entry('Another product runs on the adjacent line and the two lines are not segregated.', ['Wait until the adjacent line has finished, or run this product on a segregated line.'], ['The shift supervisor', 'QA'], ['PR-35']),
  'EBMR-PLANT-170': entry('This is a beta-lactam (penicillin) material or product and the site is not a penicillin facility.', ['Do not receive or process it here; quarantine the delivery and inform QA.'], ['QA'], ['PR-27']),
  'EBMR-PLANT-171': entry('A facility rule names the site, whether it is a penicillin facility, and the justification.', ['Complete the form and save again.'], ['The master data steward'], ['PR-27'], 'INVALID_INPUT'),
  'EBMR-PLANT-172': entry('A classification names MATERIAL or PRODUCT, the code, whether it is beta-lactam, and the reason.', ['Complete the form and save again.'], ['The master data steward'], ['PR-27'], 'INVALID_INPUT'),
  'EBMR-PLANT-180': entry('This is a controlled area: you hold no current authorisation to work in it.', ['Ask an authorised colleague to do the step, or have your area authorisation recorded by the training coordinator.'], ['The training coordinator', 'The shift supervisor'], ['PR-15']),
  'EBMR-PLANT-190': entry('The reagent use names a step of this batch and its purpose, and is recorded by a person.', ['Check the step and the purpose and record again.'], ['The shift supervisor'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-PLANT-191': entry('This reagent or buffer lot may not be used: it is expired, withdrawn or unknown.', ['Use an in-date lot of the reagent or buffer, and discard the expired one.'], ['The QC laboratory'], ['PR-29']),
  'EBMR-SITE-950': entry('A reagent lot names its lot code, kind, reagent, name, preparation and expiry.', ['Check the lot on the bottle label; use an in-date lot.'], ['The QC laboratory'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-SITE-951': entry('A reagent lot is received or prepared by now and expires after that.', ['Check the lot on the bottle label; use an in-date lot.'], ['The QC laboratory'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-SITE-952': entry('This reagent lot is recorded already.', ['Check the lot on the bottle label; use an in-date lot.'], ['The QC laboratory'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-SITE-953': entry('There is no such reagent lot.', ['Check the lot on the bottle label; use an in-date lot.'], ['The QC laboratory'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-SITE-954': entry('This reagent lot was withdrawn.', ['Check the lot on the bottle label; use an in-date lot.'], ['The QC laboratory'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-SITE-955': entry('This reagent or buffer lot has expired.', ['Check the lot on the bottle label; use an in-date lot.'], ['The QC laboratory'], ['PR-29'], 'INVALID_INPUT'),
  'EBMR-IAM-200': entry('An area authorisation names the room or line code and a name.', ['Read the reason below.'], ['The training coordinator'], ['PR-15'], 'INVALID_INPUT'),
  'EBMR-IAM-201': entry('This area authorisation exists already.', ['Read the reason below.'], ['The training coordinator'], ['PR-15'], 'INVALID_INPUT'),
  'EBMR-IAM-202': entry('The person holds no current authorisation for this controlled area.', ['Read the reason below.'], ['The training coordinator'], ['PR-15'], 'INVALID_INPUT'),
};
