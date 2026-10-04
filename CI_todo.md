# Cloud split acceptance

Each item remains in this file after completion, with its test names and evidence.
Executor implements and verifies modules; independent Tester validates the frozen
source revision. No item below is a claim of completed acceptance.

- [ ] SPLIT-C01: Main and deployed Slack fixes preserved; external caller grants, pending file recovery, Slack manual items verified.
- [ ] SPLIT-C02: Core/UI release artifacts contain only their allowlisted public runtime files; Skill consumers use exact versions and integrity hashes.
- [ ] SPLIT-C03: Cloud builds and starts without a local Skill source checkout; cross-client fixtures are development-only.
- [ ] SPLIT-C04: Local/Cloud edits, disconnect recovery, duplicate delivery and Session isolation pass against the installed Skill artifact.
- [ ] SPLIT-C05: Real Slack project selection, reply ordering, attachments and manual brief verified without disturbing unrelated conversations.
- [ ] SPLIT-C06: Production runtime revision verified; one Cloud and one Slack service; old checkout removed only after project mirror references are migrated.
- [ ] SPLIT-C07: Existing data, queues, receipts and project identities remain intact; rollback source version identified without creating source backup directories.

Known limits retained: Slack journal growth and model response latency are not
resolved by this repository split. Source tests do not establish real Slack E2E.

## Split verification evidence (not production acceptance)

- Authorization: `tests/authorization-boundary.test.mjs` and external-tool HTTP
  positive cases passed 14 checks. Fixed descendant deletion/move, misleading
  node aliases, restricted file writes, inbox leakage and project/caller scope
  intersection. No live project data was used.
- GitHub run `37207741737`: security, Slack, browser and three package checks
  passed. Node 18/22 failed because the old Skill fixture lacks the new
  `scripts/workbench/sync.mjs`; replacing it with the fixed new Skill artifact is
  required. Do not remove those tests or count this run as Required success.
- Core package imports and the Skill materializer passed on Node 18.20.8 and
  22.18.0. Materializer tests cover overwrite protection, traversal, junctions,
  manifest symlinks, exact-version mismatch and a version upgrade.
- Final local Skill fixture: `efad812eda59a6b713d0b355e6b3ba2bfbeb4b7a`,
  version `0.5.0`, tarball SHA-256
  `6e0b54a9c0f51af95a657894293b82b51b22dc93876a041aeed3ab29c08ea359`.
  Its exact 99-file package contract and security scan passed. With this installed
  tarball, `tests/hook-cloud.test.mjs` and `tests/session-sync-cloud.test.mjs`
  passed 2/2 (no skips); `.github/scripts/skill-fixture.test.mjs` passed 3/3.
  These are isolated cross-repository checks, not production acceptance. The
  release URL remains unpublished pending UI permission; clean remote `npm ci`
  and final GitHub Required are still incomplete.
- Skill `efad812` final Windows `npm test` did not complete: the existing
  900-second runner deadline terminated the run after output through test 246.
  The named-workbench test process was the remaining test child during diagnosis.
  Independent bounded reruns passed: the first test took 3.27 seconds, then the
  entire `tests/named-workbench.test.mjs` passed 17/17 and exited normally in
  147.5 seconds (180-second per-test limit; SessionStart took 92.6 seconds).
  No hang or resource leak was reproduced. Buffered file output alone cannot
  identify the timeout cause; attribution remains open. Retain the failed full
  run and do not mark full regression green or enlarge its deadline without evidence.
- [ ] SPLIT-LICENSE-01: Resolve the Ready-derived loading animation/atlas
  attribution and permission before publishing the separate UI package.
- [ ] SPLIT-DEPLOY-01: Verify the systemd templates on Linux, writable business
  mirrors, existing reverse-proxy bind, Slack readiness and data invariants.
  A deployed business mirror currently occupies the intended Cloud checkout
  location: migrate its reference before replacing that directory.
