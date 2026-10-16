# Decision record 0017: up to five agents at a time, and overlapping slices

- **Date:** 15 October 2026
- **Decided by:** project owner (maglesT), in the Phase 6 session: asked why slice 6a took about four to five hours and
  how long Phase 6 would take; offered more agents at a time so independent slices build in parallel, answered "yeah".
- **Amends:** decision 0008 ("2 to 3 agents at a time"); everything else in 0008 stands.

## Decision

1. **Up to five agents at a time** (was two to three). Model by task as before: the top model builds and fixes,
   Sonnet reviews, Haiku does mechanical jobs.
2. **Independent slices overlap.** A slice whose dependencies are merged may build in its own worktree beside another
   slice, when the two do not change the same files (for example 6f beside 6b; not 6c beside 6b, which both change the
   gateway and the simulators). Each keeps its own migration range, PR, quick review and handbook updates.
3. **Interface commits name file ownership** (which builder owns which files and folders), so parallel builders do not
   build the same thing twice (slice 6a built two worker frameworks).
4. **Local checks per slice are the changed folders** (on the spare clusters); GitHub CI is the full gate before a merge.
   The full local suite runs when a change is wide or GitHub fails.

Unchanged: tests with every feature, green CI before merging, one quick review per slice, at most two fix rounds per
finding, database enforcement for the regulation-required core.
