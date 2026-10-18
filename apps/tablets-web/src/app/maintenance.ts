/**
 * Phase 7 slice 7g-4 (decision 0025 point 2): whether this page follows a demo load or reset that recreates the
 * database (operations, DemoDataPage). Meanwhile the server answers nothing but the job's state, the meta and the set-up
 * state, and the session goes with the old database: the session poll (access controller) does not ask, so the page
 * keeps following the job instead of turning to the sign-in. Showing the job ends with a full reload of the page
 * ("Start the application again"), which starts it on the new installation.
 */
export const followingRecreation = { active: false };
