You are testing Learnova (Medhanta's LMS) as a compliance and QA tester.

Portal: https://lms.taxizee.com/
Super admin: dibakar@arieseximco.com — the portal is in Demo Mode: the one-time code is shown on the login screen
after "Send Login Code"; read it from the screen and enter it. The same works for any account you create.

Files in this folder:
- learnova-compliance-requirements.md — the minimum compliance requirements (LMS-01 ...), with how to check each.
- org_test_data_20_managers_80_employees.csv — test organisation: 100 people (example.com emails), five reporting
  levels in columns L0 (direct manager) to L4 (top). It holds two people named "Vandana Mishra", two "Divya Sheikh"
  and two "Varun Bhatt" with different emails, so it also tests duplicate names.

THIS IS A SHARED DEMO used by the whole team for internal testing. Rules:
- NEVER use "Reset Demo Data" or any bulk delete, deactivate or reset: it would wipe everyone else's testing.
- Change, deactivate or delete only what you created in this run. Before the CSV import, check whether people with
  these emails already exist; if they do, do not import over them: report it and continue with the existing ones.
- Name everything you create with the prefix "CLAUDE-TEST" (curricula, SOPs, categories, groups, questions), so others
  can tell it apart.
- No denial-of-service, load or brute-force tests; nothing that could harm the installation. Security checks stay
  observational (for example, changing an id in a URL to see whether another user's record opens).

Steps:
1. Read learnova-compliance-requirements.md fully.
2. With the browser tool, exercise every feature as each role, taking a screenshot of every finding (save them in
   ./screenshots, named by finding id):
   a. Super admin: import the CSV (Bulk Import) and check the hierarchy built from L0 to L4; add one employee by hand;
      give two employees faculty access (the toggle); make one person an Admin if the product allows; check
      categories, groups, organisation chart, workflow oversight, delegation and settings.
   b. Faculty (sign in as one of them): create an SOP by writing it, and one by requesting the content from another
      faculty member (sign in as that member and supply it); add assessment questions; send the curriculum for peer
      review (sign in as the reviewers); finalise it; assign it to a group and to one person.
   c. Employee: complete it (try to skip ahead; the 90% video rule; fail the assessment once, then pass); get the
      certificate; verify it through "Verify a Certificate" and its QR code / number.
   d. Manager: check the team overview, org chart and team report; check that a manager sees only their own line.
   e. What an auditor tries: edit or delete a completed training record or certificate; change an SOP after it was
      assigned and after people completed it; revise an SOP to a new version (are trainees retrained? is the old
      version kept?); look for an audit trail of each change (who, what, when, old and new value, reason); look for
      e-signatures on approvals and completions (what is signed, by whom, re-authentication, the meaning of the
      signature shown); two sessions of one account at once; an idle session (does it time out?); export of training
      records; time stamps and time zone on records and certificates; what a deactivated user can still do; whether a
      person can approve their own SOP or review their own content.
3. Write learnova-gap-report.md:
   - Compliance gap table: requirement id, Met / Partly / Not met / Not testable from the UI, evidence (steps and
     screenshot names), risk, suggested fix.
   - Technical gaps and bugs (functional bugs, usability problems, security observations such as session handling,
     access to other users' data by changing ids in URLs, missing input validation, error messages that leak detail,
     the demo-mode code shown on screen to be turned off for production), each with steps to reproduce and severity
     (critical / high / medium / low).
   - Summary: the top 10 things to fix first for compliance, and the top 10 technical fixes.
   - A list of everything you created (so it can be cleaned up later), and anything you could not test and why.
Ask me before anything that would change or remove data you did not create.
