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

- [ ] SPLIT-SLACK-WIN-01: Independent Tester verifies the exact frozen revision
  on Windows and Unix after the Slack Store directory-fsync boundary fix.
  Executor coverage: `plugins/slack/test/store.test.mjs` checks persisted receipts
  and bindings after reopen, Windows file fsync + atomic rename without directory
  fsync, and rejection (no acknowledgement) for file-fsync failure on both platforms
  and directory-fsync failure on Unix. All file-flush failures remain fatal;
  Unix directory errors are not swallowed. Re-run Cloud integration cases
  `Slack mirrors actual Coordinator append order...` and
  `Native Coordinator read_map...`, plus the independent Slack suite. Record
  platform, revision and results here; module mocks alone are not platform acceptance.
  Executor module run on Windows / Node 22.18.0: 5/5 passed; no full regression
  or real Slack messages were run as part of this fix.
  Independent Tester, 2026-10-05: Windows / Node 22.18.0, baseline
  `d641087bd3c9e9c0c27903c5e38a1e84be1f9500` plus the uncommitted Store fix.
  Store SHA256 `eaa4b19f5897a42d8f5f98cc883afd7030a0db5e7e5367fde32be5cef01dd0c3`;
  new test SHA256 `db25f35f709f168fddb9ee0f2da1136cb94b76ce1957b168e9a650042d72427e`.
  Review found no blocker in this change: file fsync and atomic rename remain
  mandatory; only Windows directory fsync is omitted. `npm run test:slack`
  passed 131/131 (2.52 seconds, run `69b244`); the two named integration cases
  passed 2/2 (run `ddd472`, files `tests/integration-gateway.test.mjs` and
  `tests/slack-cloud.test.mjs`). `npm run security:test` passed 39 checks
  (session `69236`, exit 0); boundary, workflow and test-governance verification
  also passed. No production Slack requests or full Cloud regression were run.
  Unix failure cases use injected platform/IO behavior on Windows, not a real
  Linux result. Node 22.18.0 is below the Slack plugin's declared >=22.19.0;
  supported-runtime, real Unix and final-commit acceptance remain incomplete,
  so this cross-platform item is deliberately not checked off.

## Split verification evidence (not production acceptance)

- Local Windows `npm test` on `d641087`, using the pinned `efad812` Skill
  fixture: 350 tests, 346 passed, 2 failed and 2 intentionally skipped.
  Both failures were Slack directory-fsync `EPERM`; their fix and independent
  targeted results are recorded under SPLIT-SLACK-WIN-01. This run exited 1,
  and is not full regression acceptance. The final supported-runtime run,
  browser acceptance and real Linux checks remain pending.

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
  release URL remains unpublished; clean remote `npm ci`
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
- [x] SPLIT-LICENSE-01: The maintainer explicitly authorized public distribution
  of the Ready-derived loading animation/atlas. The scoped source attribution and
  authorization are shipped in `prototype/LICENSES/Ready-redistribution.txt`;
  this does not license unrelated Ready code. Final package scanning and fixed
  consumer integrity are still required before publication.
- [ ] SPLIT-DEPLOY-01: Verify the systemd templates on Linux, writable business
  mirrors, existing reverse-proxy bind, Slack readiness and data invariants.
  A deployed business mirror currently occupies the intended Cloud checkout
  location: migrate its reference before replacing that directory.

- Fixed final Skill fixture: `86db8754486f61704c545bf9f1f3fff81ac2a68d`,
  `0.5.0`, SHA256 `4b409bace1ec943ac682c9c662da315bcf7dbe2a245ab68639ca1f6a636282b1`.
  It includes the shutdown-contention fix and authorized UI attribution.
  Shared UI `1.0.0` SHA256 is
  `8590f3292c312e93b6db8c680b8943b7002df7103feff6b6660ce44d117472e9`;
  Core `1.0.0` is unchanged. Both shared packages and the exact 100-file Skill
  artifact passed package safety scans. Remote download, final full CI and
  installed production acceptance are separate pending gates.

- SPLIT-EOL-01: Windows browser acceptance found the vendored Marked module
  differed from the locked upstream by CRLF conversion (74094 vs 71905 bytes).
  Preserve the exact-byte assertion. Both repositories now enforce LF for text
  and retain binary PNGs; only working-tree line endings were normalized.
  Repacked Core/UI SHA256 values are
  `0c8e9ea03f78c8c3d0ee8349c4ba071283072f1f86213200cc5a5b6cf4c04711`
  and `fb122e9014f25834fe0dc98fd9b24e874bb2f83d819c1ffd18bbbaf8d645143b`.
  Earlier package hashes above identify earlier inputs, not these artifacts.
  Final fixture pin, clean reproduction and browser/full acceptance remain pending.

- Final LF Skill fixture: `f6637d74c6c2231fd8718dacedc926a2ae3cb4ce`,
  SHA256 `55a065ee5bdece9210f6219c00d602edd3add768498c7e4a0f06e9efcdfb351c`.
  Independent Slack suite on supported Node 24.19.0 passed 131/131 without
  skips (run `acd0d5`); Windows source `dc433f1` plus LF-only attributes, Store
  SHA256 `590bbb04577f9bb56784907a718d3aa69df5c7136d2b36a86beb1a891a328ba5`.
  This does not establish Linux durability or real Slack delivery.

- Latest tested Skill fixture: `6973d1829334c0818ab66de89f7bdb553cac5cb1`,
  SHA256 `af1acb460b61189a258bcd451e81ea448869386a37e089a5cf513d9c629e8dd4`.
  It adds the verified same-value three-way reconciliation fix. Skill Windows
  `npm test` passed 382/382 plus 39 security and 29 installation checks; browser
  and journal recovery suites exited 0. Exact 100-file tarball safety scan passed.
  Cloud's installed fixture source matches its SHA256; strict fixture tests
  passed 3/3. This local tarball installation did not change the locked release
  URL and does not establish remote download or production acceptance.

- Final local regression on Windows / Node 24.19.0: `npm test` exited 0,
  348 passed / 0 failed / 2 existing separate-suite skips (274.81 seconds).
  Browser device approval BDA-012 subsequently passed; the live provider call
  remains untested. Slack passed 131/131, security passed 39 checks, and the full
  browser command exited 0 before the additional reverse-direction assertions.
  Logs: `temp/local-ci-cloud-{merge,slack,security,browser-merge}-final-20261005.log`.
  Exact 90-file Cloud service package scan passed, SHA256
  `5ec9ed57652809c833dbfd8f2ba2c45c373f7d0b718aba3b104955ab61784262`.
  These results do not satisfy remote Required or production deployment gates.

- [ ] SPLIT-PUBLICATION-01: Existing premature-publication risk, found by the
  reverse UI acceptance. A normal Session can start with an already-merged HEAD;
  later Map uploads retain that old sourceCommit. The ancestry gate returns ready,
  and no workflow tasks means the additional task gate allows publication.
  The browser can publish and switch to Main immediately; the server also has an
  automatic publisher. Static review: `sync-coordinator.mjs` creation/flush,
  `memory.mjs` mergeStatus/commitSessionMap, `server.mjs` taskPublicationReady,
  and `workbench-sync.mjs` refreshAccessNow. A readiness reproduction confirms
  Main HEAD is ready but a real unmerged feature commit is waiting; the exact
  publishing request in the failed UI run was not captured. Follow-up needs a
  completion proof tied to the current generation, Session version and delivery
  SHA at the common publication boundary. Keep Git, workflow and version gates;
  do not fix only the frontend or treat corrected fixtures as a product fix.

- [x] SPLIT-SYNC-E2E-01: Independent Tester adds the missing Cloud-to-local UI
  direction to `tests/cloud-sync-browser.mjs`: edit purpose in the Cloud Session,
  observe the local page without refreshing, verify the local Session file, then
  refresh both pages and verify durable Cloud/Local content and unchanged Main.
  Preserve the original title, safety and timestamp checks and 12/25-second limits.
  Added against Cloud `754b922c7b5cf0093fc6a5c4e8196fb2321d0720` with pinned Skill
  `6973d1829334c0818ab66de89f7bdb553cac5cb1`. Earlier browser
  success covered local-to-Cloud and refresh only, not this reverse UI path.
  First independent Node 24.19.0 execution failed (session `38111`, exit 1)
  before the reverse edit: line 125 expected URL Session `browser-session-sync`
  but observed `null` after local-to-Cloud delivery. The retained Cloud screenshot
  shows the Main/work Sessions chip and the local edit; the test did not silently
  select another Session or write into Main. Evidence:
  `output/playwright/browser-ci/session-sync-1791135863226-9b6e3872-8cd4-430d-9552-03a438b9a90e/`.
  Reverse UI delivery, disk persistence and Main-isolation acceptance remain
  incomplete; investigate fixture publication/Session lifecycle before retrying.
  Minimal isolated diagnostic `temp/publication-fixture-diagnostic.mjs` (run
  `202617`, exit 0) confirmed `sourceCommit == mainSha` yields `ready`, while
  a real feature commit with the same unchanged Main yields `waiting`; its
  three-field observations are retained in `temp/publication-fixture-diagnostic-result.json`.
  This confirms the old fixture was eligible for automatic publication, rather
  than proving a premature-publication product defect. The formal fixture now
  publishes the Main baseline first, commits an unmerged `fixture-session`
  branch, and asserts `waiting` plus unchanged Main refs before/after UI edits.
  Automatic publication and all original timeouts remain enabled.
  Corrected-fixture rerun passed on Windows / Node 24.19.0 (session `44675`,
  exit 0). Exact test SHA256:
  `b68272126991dcb963762bdbf7adf797f4ac0bb7f4a004e2dcb7c27e7688bfd8`.
  Evidence directory:
  `output/playwright/browser-ci/session-sync-1791136228767-7fdd7eec-b223-47fd-9b20-21e2f7135cbe/`.
  `result.json` records local-to-Cloud, Cloud-to-local, local disk persistence,
  both-page refresh persistence, Main isolation and the retained original checks.
  This is real Chromium against isolated local Cloud/backend and the installed
  pinned Skill artifact, not production-domain or Slack acceptance. The earlier
  failure and diagnostic evidence remain retained; no product code was changed.
