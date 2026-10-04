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
- [ ] SPLIT-LICENSE-01: Resolve the Ready-derived loading animation/atlas
  attribution and permission before publishing the separate UI package.
- [ ] SPLIT-DEPLOY-01: Verify the systemd templates on Linux, writable business
  mirrors, existing reverse-proxy bind, Slack readiness and data invariants.
  A deployed business mirror currently occupies the intended Cloud checkout
  location: migrate its reference before replacing that directory.
