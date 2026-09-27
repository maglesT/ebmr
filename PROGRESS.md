# eBMR project — progress & resume notes

Last updated: 2026-09-27 17:45 UTC. Keep this file current after every milestone.
Scratchpad root: /tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad
Durable backup: private artifact "eBMR Project Backup" https://claude.ai/artifact/3c6jFm4psAH5KZoz7GHChK
(files under backup/…; restore with Artifact action "read" + paths). Republish after every milestone:
re-run the files map from /tmp/claude-0/backup-map.json (regenerate via the snippet in section 7) and publish backup-page.html to the same URL.

## 1. What the user wants (decisions, in order — the latest wins)
- Build an electronic Batch Manufacturing Record (eBMR) system. "Hardest project". Research first, then build.
- NO repo: work is session-only (do not touch maglesT/ds or maglesT/deep-learning-for-earth-observation).
- TWO separate products: TABLETS edition (customisable within tablet manufacturing) and INJECTABLES edition
  (customisable within sterile injectables). NOT one general system. Shared internal compliance kernel
  (audit trail / e-sign / access) was proposed; architect also recommends sharing `recipe-core` — user decision PENDING.
- Target customers: INDIAN pharma manufacturers, many exporting. Rules: Revised Schedule M (mandatory) + US FDA + EU GMP
  per target market; stricter wins. (WHO-GMP not added; user only said "add revised sch m".)
- Scale: design for large companies, but logic must be "completely perfect"; very user-friendly UI; all important
  features + helpful extras.
- Accuracy over token cost ("dont worry about tokens accuracy should be there"). Use Opus for anything accuracy-critical.
- User's sample BMR (Atorvastatin tablets, Pharmaguideline) is an EXAMPLE only, not a template.
- User wanted a guidelines document for an external expert to verify -> PDF only ("leave excel just do pdf neat").
- User wants progress saved so work can resume after token/usage limits.

## 2. Done
- Research (web + user-uploaded official texts): see research/, verify/, primary/.
- Official texts supplied by user (extracted in primary/): 21 CFR 11, 21 CFR 211 (eCFR 24 Sep 2026), EU Ch.4 (2011), Ch.5 (2015),
  Annex 11 (2011), Annex 1 (2022), FDA DI Q&A (2018), FDA aseptic guidance (2004), Revised Schedule M (compressed copy, pages missing).
- Requirements register: register/requirements.jsonl (678 rows; stable row numbers n; 587 checked vs official text).
  Built by tools/merge_register.py (keeps n stable via requirements-v1.jsonl) and split by tools/split_register.py.
- Control catalogs (Opus, every row traced; check with tools/check_coverage.py):
  digest/digest-data-integrity.md (DI-01..50), digest/digest-production.md (PR-01..60), digest/digest-sterile-controls.md (ST-01..79),
  digest/digest-india.md (IN-01..52). 667/678 rows mapped to controls; 11 are not eBMR functions (discussed in notes).
- Architecture research: research/architecture.md (graph verdict: PostgreSQL system of record + recursive CTE genealogy,
  benchmarked; TypeScript end to end; Fastify, Zod, Kysely, React+Vite+React Flow, XState 5, fast-check, Vitest, Playwright;
  pnpm monorepo packages/{kernel,expr,recipe-core,...} apps/{tablets,injectables}-{server,web}; separate DB per edition).
- REVIEW PACK PDF delivered: eBMR-Regulatory-Requirements-Review-Pack-v0.9.pdf (154 pp). Builder: pdf/build_review_pack.py
  + pdf/style.css + pdf/render.js (node playwright, fonts from pdf/node_modules/@fontsource). Rebuild:
  `cd pdf && python3 build_review_pack.py && NODE_PATH=$(npm root -g) node render.js <out.pdf>`.
  Download page artifact: https://claude.ai/artifact/BPsgxDgzCAdi1CyACc7qpA (page pdf/review-pack-page.html + PDF file).

## 3. In progress (background agents; outputs appear in digest/)
- DONE: digest/digest-tablets-process.md (141 KB; 50 blocks = 26 kernel K-xx + 24 TB-xx; formulas incl. worked potency example; pharmacopoeia values flagged for QA verification; sample-BMR coverage + gaps).
- DONE: digest/digest-injectables-process.md (204 KB; 49 blocks = 19 KB-xx kernel + 30 IB-xx; 29 calculations; limit tables; all ST and IN-40..51 mapped; 24 conflicts, 13 gaps).
- DONE: digest/digest-features-ux-config.md (140 KB; 29 kernel roles, 32 separations, modules, 25 extras, 23 screens, config model, 10-gate MBR verification). Note: two agents reported an outside rewrite of their files mid-run (facts re-checked); have critics fact-check digests.
If any is missing/partial after a reset: relaunch that agent with the same brief (prompts: see section 6); they append
section by section and resume from where the file stops.

## 4. Next steps
1. When the 3 specs finish: write the BUILD OUTLINE (Opus) from digests + architecture.md; save to outline/build-outline.md.
2. Two critics (Opus): regulatory completeness vs control catalogs; logic loopholes & UX. Apply fixes.
3. Deliver outline to user (chat summary + file). Optionally add pharmacopoeia appendix to PDF as v0.9.1 (offered, not yet asked).
4. Wait for user's expert decisions on the PDF (Follow / Don't follow / Modify) and adjust.
5. Only after approval: build. Open decisions for user: share recipe-core between editions?; FDA APS tiers on US-only lines?;
   DSC/eSign for Indian e-signatures (legal counsel); pressure-difference default; missing Schedule M pages.

## 5. File index
- research/: us-regs.json, tablets.json, injectables.json, features-ux.json, configurability.jsonl, intl-*.jsonl,
  schedule-m.jsonl, architecture.md, sample-bmr-analysis.md
- verify/: *-verified.jsonl (checks vs official text), aseptic-requirements.jsonl, annex1-requirements.jsonl
- register/: requirements.jsonl (+ v1/v2), bucket-*.jsonl
- digest/: control catalogs + process/feature specs; _blocks-*.json, _guardrails.json, _sterile-blocks-and-limits.json
- primary/: extracted official texts
- tools/: merge_register.py, split_register.py, check_coverage.py
- pdf/: review pack builder and download page

## 6. Agent briefs (for relaunch)
Each brief = role + scope (two editions, India+US+EU, stricter wins, accuracy first) + inputs (paths above) + output file
+ rules (paraphrase, never >10 consecutive words from sources; append incrementally; never invent clause numbers).

## 7. Backup procedure
- Map: python3 snippet (see conversation) writes /tmp/claude-0/backup-map.json = {"backup/<rel>": {"from": <abs>, "contentType": ...}}
  for PROGRESS.md, research/*, verify/*.jsonl, register/requirements*.jsonl (current + v1), digest/*, primary/*.txt, tools/*.py, pdf scripts.
- NEVER back up src/ (third-party USP/PDA texts fetched by an agent; copyrighted) or work/.
- Also copy PROGRESS.md to /home/user/eBMR-review/PROGRESS.md.
- Backups so far: v1 17:50 UTC (partial specs); v2 ~18:10 UTC (all 7 specs complete; outline in progress).

## 8. GitHub
- User approved a NEW private repo for the code (2026-09-27). Creating it via API failed (403: integration cannot create repos).
  Asked user to create github.com/maglesT/ebmr (private, with README) and grant the Claude GitHub App access; then add_repo(push) + clone,
  first commit = docs/ (research, register, catalogs, specs, architecture, PDF + builder) + PROGRESS.md.
