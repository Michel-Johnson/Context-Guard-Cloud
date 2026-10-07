# Cloud split acceptance

## COORDINATOR-CONTROLS-FOCUS-01 · Current-main port (2026-10-07)

1. [x] Executor: empty composer ink uses the existing authenticated interrupt
   endpoint with the captured turn identity and stable retry request ID. Typed
   supplements retain send/steer. Completed/stale turns cannot stop a newer turn;
   output, resume identity, original 48-frame hue cycle and one-second transition
   remain. Multi-line phone send uses one grid cell and bottom/right anchoring.
2. [x] Executor: automatic chats, Main, legacy and existing Session scopes persist
   mounting focus and clear obsolete item identity. The next model context reads
   that node before/after restart. Mounting creates no Main item, task, execution
   Session or binding; existing binding and Main snapshots remain equal.
3. [x] Executor: terminal-runner drain outside the submission lock fixes the
   observed completion-boundary busy race without concurrent transcript writes.
   A deterministic held-runner test covers acceptance and both message identities.
4. [x] Executor module evidence: targeted mount checks passed 6/6; combined modules
   initially failed 3/36 at the completion boundary, retained as failure evidence.
   After the drain fix the combined run passed 36/36 (zero skips); adding the
   deterministic race case then passed the full steer module 8/8 (zero skips).
5. [x] Executor browser controls: real password UI/HTTP/backend/storage with a
   controlled paid model, and one lost interrupt request. Three checks passed:
   CONTROL-01 stop/retry/reload/resume, CONTROL-02 phone alignment/supplements,
   FOCUS-01 persisted Main focus/context and unchanged Main/Session snapshot.
   Run: output/playwright/browser-ci/cloud-1791386366033-55281d5b-f0de-4312-9367-c94f705d8f7d.
   Desktop, phone and multi-line screenshots inspected. Initial login URL,
   post-reload DOM readiness and synthetic missing tool-description failures are
   preserved in earlier browser output directories; no assertion weakened or
   waiting budget expanded. Phone ink repaint is observed before its screenshot.
6. [x] Independent Tester c93a13e168f36bace0676feb532d281531fe648f:
   modules 37/37 passed, browser controls 3/3 passed, zero skips, exit 0;
   starting/ending source and tracked-clean state identical. Evidence:
   output/playwright/browser-ci/cloud-1791386539019-18854610-8147-4cc8-84ab-c79206627fe2.
   Review identified the phone-arrow screenshot could precede the one-second
   repaint; now observe actual arrow/canvas opacity before recording the same
   geometry assertion. Final-revision independent recheck remains pending.
7. [ ] Final full Node/browser, unchanged Required gate, normal PR merge and
   exact merged-SHA Cloud/Slack deployment. Production checks must remain
   read-only: no test messages, business mutations, provider changes or new data.
   First full browser run passed BDA-012 and 28 workbench checks, then failed on
   a legacy submit-type selector while the ink is now a stop-type button. The
   idle assertion retains disabled/empty/not-working checks on the stable control.
   Executor c93a13e full Node passed 388/390 with two existing environment skips,
   zero failures, exit 0. Full browser (BDA-012, workbench including the three
   controls checks, Session sync) passed, exit 0. Workbench evidence:
   output/playwright/browser-ci/cloud-1791386469287-aab84a88-d7ff-4627-9ddb-c0afc49f6a90.
   Integration fetch then found concurrent Main PR #8 (38b5c82, Cloud 1.1.5).
   Both evidence sections, its 44px phone targets, model/toolbar/recovery fixes
   and attachment fix remain. Composition keeps this task's bottom anchoring.
   First integrated browser run failed a positioning declaration check because
   getComputedStyle resolves auto top to the used pixel value; the original
   Typed OM declaration check now tests top:auto and bottom:8px explicitly.
   Integrated workbench's 50 checks passed, then Session sync failed its old
   separate class/visibility reads: retained local-diagnosis.json proves the
   heartbeat had already changed synced to syncing. The invariant now captures
   class plus display:none/zero rectangles in one browser task; a visible synced
   indicator still fails immediately. No sync behavior or timeout changed.

## UI-COORDINATOR-MOBILE-02 · Integrate current Main model controls (2026-10-07)

- [x] Executor: semantic integration targets Main
  `845edb477453b16576aa8a096eba4cb321958417`, not the old `ce3b1a9b` UI.
  Keeps the project model dialog/GET/POST/version semantics and three toolbar
  controls; recovery stays after messages. Stop, its requests/listener/styles
  and the old synthetic interrupt test are not restored. Applicable phone
  title/action sizing, hidden state, 44px controls/recovery/send, composer
  exclusion and empty attachment section fixes remain. Server/model APIs,
  tests and manifest from PR #7 are unchanged. Existing failures/evidence below
  are historical revisions, not acceptance for this integration.
- [x] Executor: existing browser fixture retains original PR #7 model selection,
  persistence and safe field assertions, adds 320/390 dialog containment/close
  reachability, and adapts 320/390/1440 geometry to three controls, contextual
  recovery, idle hidden state and single/multiline composition. Ordinary
  screenshot pages keep precise page-only font fallbacks; cache/held-font
  startup tests, screenshot waits and original timeouts remain.
- [x] Executor: one affected `node tests/cloud-workbench-browser.mjs` run
  75261, Node 22.18.0, actual exit 0, 47 checks. Evidence:
  `output/playwright/browser-ci/cloud-1791385366803-a3df894f-26e6-47ef-8beb-010d7976b221/`
  (`result.json`, `coordinator-mobile-toolbar.png`,
  `coordinator-model-settings-mobile.png`, `coordinator-mobile-multiline.png`).
  These three synthetic phone screenshots were visually inspected: current
  history/model/new controls and readable model dialog, no obsolete Stop.
  Original model choice/persistence, cache/held-font startup, attachment/memory
  and version checks passed. The attachment share error is the unchanged
  deliberate retry fixture. No new assertion failed on this integration run.
  App SHA-256: `dc273a1cd086bdc850d369559aac1955028e35e1b56aaf670ae8cf94f7761c0e`.
  CSS SHA-256: `daceb92ba5d19eab809ca5ee75d20df59bf1002aef7646f708236c1e4f250e15`.
  Browser SHA-256: `17f4d0c42cf27e44338dc1df9dbbb72dc141c69caffdcc20d22d09edaabc8ef3`.
  Syntax/diff checks passed; product conflict markers are gone. New Main
  server/model APIs/tests/manifest have no diff from the exact 845 base.
- [x] Independent Tester: reviewed exact 845 integration and ran the affected
  formal module once on Node 22.18.0, session 97104, actual exit 0, 47 checks.
  UTC 2026-10-07T15:07:24.3829127Z to 15:09:11.3683099Z. App/CSS/browser
  hashes above stayed unchanged; server/model APIs, their formal tests and
  manifest have zero diff from 845. Artifact:
  `output/playwright/browser-ci/cloud-1791385647575-4f9d7d49-e48a-4be1-bb46-6b161e327297/`.
  Viewed this run's phone toolbar/model-dialog/multiline screenshots: three
  current controls, no obsolete Stop, readable/selectable model dialog with
  reachable close/apply and composer exclusion. Model UI request/persistence,
  contextual recovery, cache/held-font startup, prior mobile layout, attachment
  retry, memory/Main and completion checks passed. Raw log SHA-256:
  `12f4571789309780834423d231dcee595dc983662ee16ed8010c5bd984c77352`.
  This is evidence for the new merge working tree, not inherited ce3 results.
  Real Safari/physical phones, full RTL and
  native 200% zoom remain unverified. Executor does not stage, commit, push,
  deploy, install or change production/user data.

## UI-COORDINATOR-MOBILE-01 · Historical ce3 toolbar/composer evidence (2026-10-07)

This section documents the earlier ce3 implementation, including its now-removed
Stop control. Its hashes and passing runs are retained as history only; the
current Main model controls require UI-COORDINATOR-MOBILE-02 acceptance above.

- [x] Executor: canonical toolbar action CSS now respects native `hidden`.
  The stop text uses a non-shrinking content-sized, non-wrapping control;
  desktop icons retain 28px visual density. Phone heading and actions occupy
  separate rows, action/send targets are actual 44px controls, and the composer
  reserves 60px for the send target. Explicit `bottom:auto` removes the legacy
  competing vertical constraint. Existing stop/retry/Enter/send behavior,
  Map/permissions and prior UI-MOBILE-LAYOUT-01 changes are preserved.
- [x] Executor: new synthetic scenarios in the existing browser module passed
  at 320/390 phone and 1440 desktop: idle hidden controls, running/failed-read
  four-action containment, one original interrupt with exact turn ID, disabled
  in-flight stop, enabled/disabled send and single/multiline input exclusion.
  The 390px toolbar and multiline screenshots were visually inspected.
  No private conversation text or screenshot is included in the fixture.
- [x] Executor: final affected `node tests/cloud-workbench-browser.mjs` run
  73734 passed, actual exit 0, 47 checks, Windows / Node 22.18.0. Evidence:
  `output/playwright/browser-ci/cloud-1791371639220-f7c6a1b5-2327-4b49-bb26-6e469c5d91c7/`
  (`result.json`, `coordinator-mobile-toolbar.png`,
  `coordinator-mobile-multiline.png`, `cloud-session-edit.png`). Both new
  phone screenshots were visually inspected. Original cache, independently
  held-font startup, attachment retry, memory, Main and version checks passed.
  Main-page external-font routes use local fallbacks only after the unchanged
  warm-cache acceptance; screenshot waiting and the 35000ms budget remain.
  The attachment share error is the existing deliberate successful retry fixture.
- [x] Run 60423 emitted all business checks but exited 1 when the original
  final full-page screenshot waited 35000ms for external fonts; it was not a
  passing module result. Evidence:
  `output/playwright/browser-ci/cloud-1791370774742-103c28ad-539a-46e2-98f4-d080af37d3ad/`.
  The original screenshot timeout remains recorded.
- [x] Earlier failures retained: run 11332, exit 1, added assertion mistook
  CSSOM's used bottom coordinate for the declared `auto`; verified Typed OM
  and corrected only the assertion. Evidence: `output/playwright/browser-ci/cloud-1791370572582-70230000-3a7e-4ba5-bee5-79ce5b5a3352/`.
  Run 77500, exit 1, new running-state fixture preceded the original default
  accessible-label assertion. The scenario was moved after original defaults;
  no original assertion was weakened. Evidence: `output/playwright/browser-ci/cloud-1791370682354-9776a0c8-3bde-4c9b-b577-d8f07a8839dc/`.
  Run 10748, exit 1, a page-only external-font route was initially installed
  before the existing private-cache acceptance; Playwright routing disables
  the page's HTTP cache. The cache assertion remains unchanged. Evidence:
  `output/playwright/browser-ci/cloud-1791371404156-333955b0-a31e-41b3-85de-f1c6c719323d/`.
- [x] Frozen product hashes: app `f2a97df1b04e3033c1947bedaf9ff0ba757cd1ea35ab18d490f6893267517a89`;
  CSS `6b1944e03a9433da5f955b168c029d4a3fbb1dfa482cb7b2a531e5815b603dd4`.
  Browser hash at run 60423: `3317d32f5474d773983c9e0e63bf5aaf78e4f220a8372893320df10184bc17e6`.
  Browser SHA-256 at Executor 73734 / Independent Tester 99131:
  `66c1464e996f09908f9c15b9c590a32ee88320d4fead9651e8dc5d846216deaf`.
  Syntax and diff checks passed. The post-fix synthetic toolbar screenshot
  shows no yellow strip; its separate root cause is not established.
- [x] Independent Tester failure evidence: exact final app/CSS/browser hashes
  above remained unchanged during one affected standalone run, Node 22.18.0,
  session 99131, UTC 2026-10-07T11:27:16.3812209Z to 11:29:58.2485092Z.
  Actual exit 1, 41 completed-check lines and no `result.json`; not a passing
  full module. Existing attachment-page screenshot at browser line 1870 timed
  out after its original 30000ms waiting for fonts, before clicking retry.
  The main-page font route does not affect this independent attachment page.
  New Coordinator geometry/stop assertions and prior mobile-layout/cache/held-font
  startup checks completed; visually inspected 390px toolbar/multiline PNGs.
  Artifact: `output/playwright/browser-ci/cloud-1791372439806-39203452-194a-4155-a07d-2be2951f7c16/`;
  `failure.txt` preserves synchronized UI and the deliberate share-error/retry
  state; later attachment/memory/completion checks were not reached. Raw log
  SHA-256 `2b833dc7a5241ff68c871b942c2fbe4f5894f8b07c67d437fa9168ad53a4a18a`.
  Screenshots/report were retained; the original finally cleaned its synthetic
  data directory. No retry, timeout/assertion change or source fix was performed.
- [x] Executor: after the independent failure, only the existing screenshot
  fixture uses one page-level helper for precise Google `/css2` and gstatic
  font requests. Main calls it after unchanged cache/reopened assertions;
  attachment/mobile screenshot pages call it on creation. No context-wide
  routing, product change, `startupPage` held-font interception change,
  screenshot bypass, timeout increase or assertion weakening. Latest browser
  SHA-256: `d2adcffe2734c18cbcaa5394185f4fe485591dde39d53af830274a2541b1b618`.
  Product hashes above are unchanged; syntax/diff checks passed. This latest
  fixture was not executed again by Executor; independent final acceptance
  remains pending. All preceding failures and passing revision evidence remain.
- [x] Independent Tester: final affected standalone module against app/CSS
  hashes above and browser `d2adcffe2734c18cbcaa5394185f4fe485591dde39d53af830274a2541b1b618`
  passed once, Windows / Node 22.18.0, session 41089, actual exit 0, 47 checks.
  UTC 2026-10-07T11:47:26.3226538Z to 11:49:06.2543014Z; all three input
  hashes remained unchanged. Artifact:
  `output/playwright/browser-ci/cloud-1791373647647-32c85a96-735b-452f-a8f6-d9145b02d4ec/`.
  The exact font helper remains page-only, installed after original main cache
  assertions and on mobile/attachment screenshot pages, never on startupPage.
  Original held-font startup, private cache, 320/390/718 mobile/desktop,
  Coordinator stop/send geometry, attachment retry, memory, Main and completion
  checks passed. Independently viewed final 390px toolbar/multiline PNGs.
  Raw log SHA-256 `0fedfc0b978223f6800496e1c0b4b29ba5d8dcd3934e21f4189f34f47b56cd2e`.
  Prior session 99131 exit 1 and all earlier failures remain recorded; no
  assertions, screenshot waiting or original timeout budgets were reduced.
  Real Safari/physical phones,
  full RTL, native 200% zoom and this change's 200% layout simulation are not
  verified. No commit, push, branch, install, publication, deployment or
  production/user-data modification occurred.

## UI-MOBILE-LAYOUT-01 · Toolbar clipping and empty attachment separators (2026-10-07)

- [x] Executor: phone toolbar no longer inherits a 36px border-box height while
  spending 6px on vertical padding. Its auto/min-height contains the unchanged
  controls and their text; desktop rules and horizontal scrolling remain intact.
  Detail rendering omits only an attachment section with neither upload capability
  nor existing files. Existing references, upload-enabled empty entry, memory
  documents and all underlying records remain unchanged. No user screenshot
  content or private project data is copied into the synthetic acceptance fixture.
- [x] Executor: one affected `node tests/cloud-workbench-browser.mjs` execution
  (Windows / Node 22.18.0, run 24764) passed, exit 0. Covers toolbar containment
  and centered label at 320/390/718 forced-phone widths and 1440 desktop;
  overview with disabled uploads/no files omits the blank bordered section,
  memory remains accessible, an existing reference is still visible without
  upload, and the upload-enabled empty entry/actual upload retain original tests.
  Only the isolated service's overview fixture is staged and restored; project
  Main version and complete Map are unchanged. Syntax and diff checks passed.
- [x] Evidence: `output/playwright/browser-ci/cloud-1791369008768-a7377127-f610-476c-897c-98cdc62251a0/`
  (`result.json`, `mobile-toolbar-320.png`, `mobile-toolbar-390.png`,
  `mobile-toolbar-718.png`). The 390px screenshot was visually inspected.
  No new assertion failed on the first run. The logged attachment share failure
  is the original deliberate retry fixture and its subsequent upload passed.
  App SHA-256: `9e5c0dc497fc2599d380ba3a3929e60749621e0cf40918316772f075c67f9f37`.
  CSS SHA-256: `55826dcb9b7cb66b1bb446b825db14fbc95e8648df736c1719722a23c173ac21`.
  Browser SHA-256: `6b5daf8a4723bd37f60861df5df5627f5cacaffebcfe0965979a8de40c61857f`.
- [x] Independent Tester: reviewed the frozen three product/test hashes above
  against base `ce3b1a9b1bbce081e80141712ba44d110093fd57` plus this four-file
  local diff, then ran the original affected module once on Node 22.18.0.
  Actual exit 0, 46 checks, UTC 2026-10-07T10:37:57.3648831Z to
  10:39:40.1801095Z; product/test hashes remained unchanged. Artifact:
  `output/playwright/browser-ci/cloud-1791369479120-f9c15304-59c9-4a42-b791-9cdcc6c5cfeb/`.
  Visually inspected the 320px and 390px screenshots: Session label is contained,
  no empty attachment separator remains, and memory/Idea/TODO/Bug controls remain.
  Original desktop, existing/upload-enabled attachments, retry, read-only Main
  preservation and version/permission checks passed. Log SHA-256:
  `0fe3c70e351cec760624616d22041730dfb9215675ed3b384866a3e577ddfc38`.
  Toolbar-only RTL geometry and 200% body CSS zoom simulations passed; these are
  not full RTL support or native browser zoom acceptance. Real Safari/device
  testing was not performed. No full-suite repetition, install, source commit/push,
  publication or deployment occurred. The share failure was the existing deliberate
  retry fixture, not a failing assertion.

## R3-STATIC-PREVIEW-01 · Device tools tolerate missing server config (2026-10-07)

- [x] Executor: one optional-chain guard in canonical `installDeviceApprovals`
  returns safely when `sync.config` or its feature capability is absent. No
  preview-specific behavior, Skill generated copy, dependency lock, permission,
  release metadata or production state change. The original Skill browser scene
  `cg-browser-ci-zH4Jjq` remains first product-failure evidence, not a selector bug.
- [x] Executor: existing BDA012 retains real configured-device approval and adds
  a static page using canonical HTML/assets without `__CG_SERVER`. Only its HTML
  and exact synthetic Map GET are routed; app/assets are not replaced. The actual
  root appears and accepts a click, device entry stays hidden and `pageerror`
  stays empty. A VM diagnostic of the actual extracted installer confirms the
  missing-config call returns with the fixed guard and reproducibly throws
  `interfaceCapabilities` with only the guard reverted (exit 0).
- [x] Executor: syntax and diff checks passed. One affected standalone
  `node tests/browser-device-login-runner.mjs` (Windows / Node 22.18.0, run 31744)
  passed 1/1, zero skips, exit 0, without changed timeouts, sleeps or force.
  Evidence: `output/playwright/device-approvals-1791358177802/`
  (`result.json`, `static-preview-no-config.png`, `device-requests-phone.png`).
  App SHA-256: `72e2df4530736b87c1290c9273970ae460f41cda6752dd398b701ccfa22c3c13`.
  Test SHA-256: `37d62efa260350b093fbb6a511ce254c8f835c07fb20f0294a94867579c6bc53`.
- [x] Independent Tester: BDA012 run 17501 (Node 24.19.0) passed 1/1, exit 0,
  on the same frozen app/test hashes before and after execution. Real static
  root/click without `__CG_SERVER`, hidden approval entry, zero page errors,
  configured approval and phone scope/close checks passed. The old guard's
  in-memory negative check still throws TypeError. This is technical acceptance,
  not human device approval or production/native Skill browser acceptance.
- [ ] Release 1.1.4: exact Cloud/Core/UI packages, unchanged complete Required,
  normal Main merge/CI and new immutable shared-v1.1.4 assets. Earlier 1.1.3
  static-preview failure remains preserved; no old asset or tag is replaced.

## RELEASE-1.1.3: persistent human device approval and current UI delivery

- [x] Preserve the exact independently verified authorization/UI source and all
  earlier failures; root, Core and workbench manifests advance together to 1.1.3.
  Existing fixed Skill 0.6.3 fixture stays unchanged to avoid a publication cycle.
- [x] Metadata boundaries, workflow/governance and exact Cloud/Core/UI package
  security passed locally: Cloud 90 files, Core 44 files, UI 13 files. These
  package checks do not substitute for remote functional or browser acceptance.
- [ ] Pass the unchanged six-job Required gate on the release PR.
- [ ] Merge normally, bind the immutable shared-v1.1.3 assets to that merged
  source revision, and independently verify anonymous downloads and checksums.
- [ ] Server deployment, installed Skill upgrade and real human approval remain
  separate acceptance steps; package publication does not complete them.

## DEVICE-APPROVAL-PERSIST-01 · Project tools and persistent pending requests (2026-10-07)

- [x] Executor: pending device requests no longer expire or get evicted. Existing
  unclaimed legacy pending records migrate only with the original identity and
  current repository authorization; absent old records are not fabricated.
  Denied/claimed/expired-approved requests never restart as pending. Approval
  retains a finite claim window; cookie/device credential lifetimes, scoped
  privileges and persist-consumption-before-issue remain unchanged. The 1000
  capacity counts pending, not terminal history; existing requests can retry.
- [x] Executor: `X-Context-Guard-Device-Grant: persistent-v1` negotiates
  pending `persistent:true/status:pending/expiresAt:null/expiresIn:null`;
  approved requests return `persistent:false/status:approved` with a finite
  claim window. Old clients retain finite wire waiting budgets and may stop
  locally after ten minutes; that is not server pending-request expiry.
- [x] Executor: two project-scoped GET routes enumerate safe request metadata
  or prepare a short-lived decision ticket. Only the human workbench Cookie
  is accepted; Bearer alone, cross-origin and cross-project requests are denied.
  Decisions retain the original endpoint, Origin/CSRF checks and hard repository
  scope. No deviceCode, hashed secret, credential or password enters the list/DOM.
  `/connect` uses only its exact script SHA-256 plus same-origin fetch permission;
  login and other page CSPs remain unchanged, without unsafe-inline script access.
- [x] Executor: Workbench Tools exposes pending count and human Allow/Deny.
  No countdown; bounded phone dialog, close/Escape/reopen, explicit known errors,
  unavailable `?` count and disabled stale actions. Fresh unchanged data preserves
  focus/scroll; opening during a summary read requests one full list after that
  read succeeds. Existing Map heartbeat triggers an independent caught refresh,
  never waits for that API, and keeps its original 10000ms schedule.
- [x] Executor module evidence, Windows / Node 22.18.0: BDA001..009/018/019
  passed 11/11 in run 85502 (exit 0). A later combined Node run 12112 retained
  13 pass / 1 AUTH001 failure (legacy absolute waiting-budget equality), not
  success. AUTH001 now asserts full persistent reply equality and stable legacy
  identity plus real finite budget bounds; final `interface-auth` module passed
  11/11 (exit 0), preserving credential expiry/revocation/isolation tests.
  The focused `device approval refresh` heartbeat regression passed 1/1 (exit 0),
  including a never-settled approval request and rejected ancillary callback.
  Syntax checks and `git diff --check` passed. No full Node/browser suite claimed.
- [x] Executor browser evidence: the first BDA012 run 40567 failed because
  `/connect` CSP blocked the new ticket script/fetch. Its record remains at
  `output/playwright/device-auth-r3-first-failure-20261007.md`; Node's first
  failure remains in `device-auth-r3-node-first-failure-20261007.md`.
  Earlier runs 16216 and 17921 passed but predate final heartbeat/race changes.
  Final affected `node tests/browser-device-login-runner.mjs` run 40768 passed
  1/1, zero skips, exit 0, without widened budgets/forced clicks/sleeps.
  Evidence: `output/playwright/device-approvals-1791345725057/`
  (`result.json`, `device-requests-phone.png`). Covers real password approval,
  exact-script CSP, tools count, held-summary/open-dialog/full-list race,
  safe labels, focus preservation, phone close, Allow/Deny, expired-login `?`
  recovery and reload. Final browser test SHA-256:
  `b43648e315c65d893196fb6dbfd21d5bebb6c79464fd24b89e9f7af884344c4d`.
- [x] Executor final disclosure-only follow-up: the device request dialog now
  states in Chinese/English that only self-initiated connections should be allowed,
  granting Main read and own Session read/write but no administration/Main
  publication. No permission or protocol behavior changed. BDA012 adds a visible
  disclosure assertion and retains phone-close/internal-scroll, approval,
  summary/open race and error-recovery assertions. Only the affected
  `node tests/browser-device-login-runner.mjs` was run: 1/1, zero skips, exit 0.
  Final evidence: `output/playwright/device-approvals-1791346526355/`.
  Browser test SHA-256:
  `c27158a287446fb5052a731659792f62ec894535478edd5658494836256620df`.
  Above run 40768/hash remains pre-disclosure evidence, not this final revision.
  The earlier focused BDA019 follow-up passed 1/1 using two valid configured
  projects/repositories/IDs, proving both lists and cross-project detail/decision
  rejection plus real configured admin-Bearer rejection; it did not mutate product
  source. Independent Tester must confirm the final affected revisions.
- [x] Independent Tester: verify exact Cloud and new Skill revisions, run fresh
  authenticated HTTP across two valid projects (not merely an unknown route),
  revoked repository and credentials, old pending migration and terminal replay,
  plus real persistent Skill recovery/unknown one-time claim handling. Review
  no-secret HTML/log/URL boundaries, no unchanged-read disk writes, preserved
  Map cadence and dialog focus. Existing browser evidence uses the pinned older
  client artifact, not a newly installed Skill. No production deployment,
  installation upgrade, Git push or human acceptance has occurred.
  Independent Node 24 Cloud checks passed 11 device + 11 auth + 1 heartbeat +
  1 browser (all actual exit 0), with pre-disclosure browser evidence at
  `output/playwright/device-approvals-1791346251995/`. Final disclosure UI alone
  independently passed BDA012 1/1, exit 0 (run 91223); evidence
  `output/playwright/device-approvals-1791346617708/`, final test SHA above.
  New Skill full Node 22 client module passed 22/22; Node 18/24 each passed
  five compatibility targets. Cross-repository real isolated HTTP passed 7/7
  against current server/client, including owned-worker request recovery,
  two valid project scopes and unchanged Main/Session content. Private evidence
  remains in the Skill worktree temp reports, not public credentials or Map.
  Scroll preservation and unchanged-read disk behavior were statically reviewed,
  not separately dynamically asserted. Function-layer cancellation is not public
  CLI or Native acceptance; long expiry coverage used controlled module clocks.

## UI-TRAY-CLOSE-01 · Cancelled proposal tray dismissal (2026-10-07)

- [x] Executor: canonical workbench adds a translated native close button and
  synchronized trigger `aria-expanded` / `aria-controls`. Button, non-editor
  Escape and outside clicks close only UI state. Capture-phase outside handling
  respects tray controls and still reaches settings/session controls. Bug and
  Coordinator panel openings use the same close helper. Escape skips editors,
  composition and open dialogs; outside dismissal does not steal target focus.
- [x] Executor: bounded tray with a fixed header and independently scrolling
  list keeps the close button visible on narrow screens. No authorization,
  expiry, API, Skill source, production data, package or deployment changes.
- [x] Executor verification: `node --check prototype/workbench-app.js`,
  `node --check tests/cloud-workbench-browser.mjs` and `git diff --check` passed.
  One affected standalone `node tests/cloud-workbench-browser.mjs` execution
  (Windows, run `83959`, exit 0) passed, including the numbered tray scenario:
  internal delete-confirm cancellation, button/Escape/outside dismissal,
  editor Escape retaining text, focus return to visible Settings, 390px list
  scrolling with a reachable close header, zero Map commits and unchanged
  authoritative Main version/content. No full-suite or production test claimed.
  Browser SHA-256:
  `e9d8d6ff8cad64042d14baccaf948e75ef5f5a6467e5b86919c9bd024e03b6f5`.
  Evidence: `output/playwright/browser-ci/cloud-1791342397982-9c461139-d853-4d7b-9886-19593a333dc2/`
  (`result.json`, `cancelled-tray-phone.png`). This first execution had no failed
  tray assertion; the attachment share failure in its log is the pre-existing
  deliberate retry fixture, not an ignored product failure.
- [ ] Independent Tester: verify these exact uncommitted canonical file hashes,
  rerun the affected browser module, inspect desktop/phone controls, test opening
  Bug/Coordinator while the tray is open clears trigger state, and confirm real
  restore/delete-confirm actions remain functional without premature dismissal.
  Recheck composition/dialog Escape isolation and no lost editor draft. Do not
  mark production deployed or human accepted from isolated browser success.

## BINDING-CONFLICT-01 · Preserve Session ownership and explain recovery (2026-10-06)

- [x] Executor: cross-device `session.bind` remains HTTP 409 / `CONFLICT`;
  details contain only `reason: session-bound-elsewhere`. Binding authorization
  and Agent checks still run first. Same-device version and explicitly allowed
  worktree migration semantics remain unchanged. No takeover/migration API,
  old Session rewrite, queue removal, package bump or production operation.
- [x] Executor: canonical UI consumes only the agreed safe `/api/cloud-sync`
  conflict reasons. `session-bound-elsewhere` displays the old-device notice;
  legacy `binding-conflict` displays the generic notice. Reconnection clears the
  notice. Retry/login actions remain unchanged; backend message text is not shown.
- [x] Executor module verification, Windows / Node 22.18.0:
  `node --test tests/interface-store.test.mjs tests/interface-auth.test.mjs`
  passed 26/26; `node --test --test-name-pattern="binding conflict UI"
  tests/cloud-workbench.test.mjs` passed 1/1;
  `node .github/scripts/verify-test-governance.mjs` and `git diff --check` passed.
  Each of these four verification commands exited 0.
  Tests cover sanitized HTTP errors, restart reads, unchanged old binding/queue/
  existing receipts, permission rejection, owner reuse and same-device migration.
  The fresh Session in the store regression is a synthetic fixture, not a real
  Codex-host acceptance result. No full-suite or production acceptance claimed.
  - [x] Independent Tester, Cloud-side scope: exact initial release revision
    `f74b07e4085bfb9420a20c8b0c31bdf8912838e3` passed on Windows with Node
    18.20.8 and 24.19.0. `interface-store` + `interface-auth` passed 26/26 per
    version, zero skips; the canonical binding-conflict render case passed 1/1
    per version. Node 18's focused UI report additionally lists 38 name-pattern
    exclusions, not 39 passing cases. The UI case extracts the actual canonical
    renderer into a VM; it is not a real local status-endpoint/browser assertion.
    Static review confirms verification/Agent checks precede conflict reporting,
    cross-device errors expose only the agreed reason, and same-device migration
    and version guards remain intact. User/backend message text is not rendered.
  - [x] Independent Tester: the original preservation fixture had empty task and
    object collections; do not treat that run as populated-state preservation.
    Executor strengthened only `interface-store` in
    `417cb12a255dcdd9e9c1a9509319e09a55de5d5c`, using normal `object.put` and
    `brief.submit` to seed a nonempty old plan, task and notification, with exact
    content/Session assertions before rejection. At final revision
    `f0038fe81d283b3beefc6341dc9168506e4dc7f6`, an independent focused run passed
    1/1 on Node 18 and 24, retaining the original rejection and deep-equality
    assertions. Node 18 also reports 14 unrelated name-pattern exclusions.
    Exact enhanced test SHA-256:
    `c80955546fac84abae17f308fa3e6b63b9d0e21c18715130af7f5db034f0aa2a`.
  - [x] Independent Tester: one unchanged formal `npm run test:browser` at
    `f74b07e` completed with exit 0 on Node 24.19.0: BDA-012 1/1, Cloud workbench
    44 checks, bidirectional synchronization 7 checks. The approximately
    171-second log timestamp interval is an observation, not monotonic timing or
    a changed budget. Runtime/UI/browser inputs remained byte-identical through
    `f0038fe`; the subsequent changes affect only the stronger store test and
    excluded interface documentation. Browser log SHA-256:
    `bfd1f6d89d5cfaa035c9960e75666fbdf519990bec468d06ff96bad5f8c807c9`.
    Artifacts: `output/playwright/browser-ci/cloud-1791257553630-e4ac845e-8803-492d-a95a-62e6d24861e9/`
    and `output/playwright/browser-ci/session-sync-1791257652697-c88a5840-fc82-4b42-8600-b3743927dee5/`.
    This Chromium run uses loopback-only isolated Cloud/backend and the public
    pinned Skill 0.6.3 fixture; it does not test the still-unreleased new Skill.
  - [x] Independent Tester: local exact Cloud/Core/UI 1.1.2 packages passed the
    security/file contract, respectively 90/44/13 files. SHA-256:
    Cloud `20444a2007c87f1de1541d47c1feb5039fec4312dc66a5ba9017367b14637a18`,
    Core `a925414081652567050ccf9055d4f7aa4f7513720046e49d2c13c49c5cbd35d8`,
    UI `eeb67f824ac7f2efe6cd898be256b80a1da99d0cbe5d943266e98c45db0abc81`.
    Boundaries, test governance, workflow verification and diff check passed.
    These are local package previews, not public-download or production evidence.
  - [ ] Independent Tester, client-side integration: test both UI reasons through
    the local public status endpoint, confirm a failed saved receipt is not
    retried with a new ID and old queues remain preserved. This requires the
    separately frozen Skill implementation; renderer-only verification does not
    close this item. Original assertions/timeouts were not weakened, no force or
    local fixture fallback was used, and no production data or personal Hooks
    were changed. Remote Required must verify the final commit independently.
- [ ] Coordinator / independent Tester: after fixed Core/UI publication and
  exact Skill dependency update, use an actual newly created Codex host Session
  for connection acceptance. Record released artifact versions and host evidence;
  do not invent a Session ID, migrate the old binding or mark a mocked run live.

## FIXTURE-063-01 · Fixed released Skill integration fixture (2026-10-05)

- [x] Executor: update only the development fixture from 0.6.1 to official Skill
  0.6.3, released from Main `ea386fe216bc292c00b39268559905e9e0126742` after
  PR #451 and successful official npm CD `37313581463`. The coordinator verified
  the registry artifact against the CD artifact before this fixture update;
  631017 bytes, SHA-256
  `588cef623cc033c1172ef6261498a48a385df908fe7a710c0b06bcb1181e522a`.
- [x] Executor: npm generated the lock from the immutable public release URL
  `https://github.com/Michel-Johnson/Context-Guard-Skill/releases/download/split-fixture-ea386fe216bc292c00b39268559905e9e0126742/michelj-context-guard-0.6.3.tgz`.
  Its canonical SHA-512 is
  `sha512-bM+A3J8pLAEbO/wevL3TP/NUSN6rgIMpiq91OFPHJ3yQJoOLuJibR5knhhWVRVkOtdCl9ppgrfCGFeDipBGKVQ==`.
  `npm ci --ignore-scripts --no-audit --no-fund` installed that exact package;
  the helper resolves version 0.6.3 from this repository's node_modules. No
  local-file fallback, copied client source or postinstall hook changes were used.
- [x] Executor: `node --test .github/scripts/skill-fixture.test.mjs` passed 3/3;
  `node .github/scripts/verify-boundaries.mjs` and
  `node .github/scripts/verify-test-governance.mjs` passed. Approved 0.5.0,
  0.6.0 and 0.6.1 remain accepted alongside 0.6.3; 0.6.2, 0.6.4, 0.6.30,
  latest, non-fixed URLs and mismatched locks/installed identities remain rejected.
  Cloud/Core/UI 1.1.1, all other dependencies and browser tests are unchanged.
  - [x] Independent Tester: on the frozen five-file diff, verify the installed
  0.6.3 fixture and lock, then run the unchanged official `npm run test:browser`
  entry (device authorization, Cloud workbench, cross-product bidirectional sync)
  with existing budgets and assertions. Record exact Cloud revision, Skill SHA
    and results. These module checks do not establish browser E2E, live user
    connection or production deployment acceptance.
    Independent Windows / Node 24.19.0 verification used Cloud HEAD
    `29a6c9853d3bb65504757eb7219660be3850df1d` plus exactly the five reviewed
    fixture/document changes on `codex/skill063-fixture`. Anonymous curl downloaded
    the public 631017-byte artifact with SHA-256
    `588cef623cc033c1172ef6261498a48a385df908fe7a710c0b06bcb1181e522a`;
    its SHA-512 matched the lock. `npm ci --ignore-scripts --no-audit --no-fund`
    used a new isolated cache and installed version 0.6.3, not a sibling checkout.
    Independent fixture validation passed 3/3 with zero skips; source boundaries
    and test governance passed. One unchanged `npm run test:browser` completed
    with exit 0: BDA-012 1/1, Cloud workbench 44 checks, cross-product sync 7 checks.
    The roughly 139-second log interval is an observation, not a changed budget.
    Inputs and both formal browser source hashes stayed unchanged; diff check passed.
    Browser log: `temp/tester-fixture063-browser-20261005.log`, SHA-256
    `1eb08c9d7450b9c95da18c1dc7bc649439a3b94f2ff496a0c143daf90875f1ac`.
    Successful result artifacts:
    `output/playwright/browser-ci/cloud-1791206654947-75487486-2602-4c1f-bab7-c02c57838c12/result.json`
    and `output/playwright/browser-ci/session-sync-1791206746014-de582597-5d16-47cb-9b38-c88a3f3474dc/result.json`.
    These are real Chromium against isolated loopback Cloud/backend using the
    installed public Skill fixture. No force, skip, local fallback, production
    mutation, user Hook changes, commit or push was used. Remote Required and
    actual production/user-device acceptance remain separate pending gates.

## Final delivery status (2026-10-05)

- Cloud #1 merged normally into `2b47df759ee567e8d53f569cc56a50c19f616a47`; Skill #449/#450 into `3773aa9` / `4ae1788eb93cc8d0b62e60e376d4387843abce43`. Official npm **0.6.2** CD run `37271755297` succeeded on all three install/upgrade platforms, OIDC and post-publication exact/latest checks. Cloud still pins the distinct immutable GitHub **Skill fixture 0.6.1** at `8f144fb`; shared Core/UI remain 1.1.0 and old release assets were not overwritten.
- Production Cloud 1.1.0 is running from `/opt/context-guard-cloud/repository` at `2b47df7`, with formal Slack 0.1.14. One formal Cloud and one formal Slack service are active; candidate services are disabled. Business mirror HEAD is `4ae1788`. Both projects' Main/Session/closed/history hashes match before and after deployment; the two-document memory UI is visible in real Edge (`output/cloud-release-1.1.0-proof.jpg`).
- [x] Read-only Slack state comparison against verified business backup `pre-split-release-20261005T061504215Z.tar`: stateVersion unchanged; inbox 327→327, threads 9→9, channels 2→2, preferences 1→1, drafts 3→3, outgoing 105→105. All old IDs and thread project/conversation bindings remain; no real IDs or content are disclosed. This proves structural retention, not every payload or execution outcome.
- The inbox/outgoing/channels/preferences/drafts JSON values also match exactly; environment files are byte-identical and memory credential equality was checked as booleans only. Threads have expected post-start control/input/status/poll evolution; their original mirrored receipts and ownRequests sets remain. Full workflow/payload execution acceptance is still not inferred.
- Codex/Cursor/Claude local Skill copies installed official npm 0.6.2 explicitly with `--no-hooks`; launcher/SKILL.md/Hook-script hashes match the published package and the three host Hook files remain unchanged. Live user bidirectional connection is still unverified: local backends are stopped and this Session is unbound.
- Real Slack E2E remains open: production probe has `authenticated:true`, `usersRead:false`; token authentication/service-active does not prove other-bot silence, Steer or live conversations. After explicit user confirmation, obsolete candidate source and its disabled unit were removed as recorded under SPLIT-C06; business data and backups were retained.

## SESSION-VIEW-01 · Opt-in other Sessions (2026-10-05)

Fresh immutable release preparation: Cloud/Core/UI manifests are 1.1.1; Skill
0.6.3 fixes the matching shared-v1.1.1 URLs/integrity. Local exact package scans
passed (Cloud/Core/UI: 90/44/13 files). Core SHA-256 is
`508ec89fb050a426c97b6fb83eb131d8fd2f283578d7aa7c77c6c7ec59de6672`, UI
`2441811b9dfecc6b58e34e5cd7bbef9dfb2902cb8dc1ddaf6b1eb241920811e8`.
Anonymous public download, PR/Required, client publication/install and production
delivery remain separately pending here; the old 1.1.0 assets are not replaced.

- [x] Executor: keep the working-only default; add a non-persistent other-Session toggle using the existing authorized view. Closed Sessions stay excluded and stale bindings cannot be selected. Cloud snapshot availability is checked before flushing the current draft; failed switches retain the original map, query, version and recovery state rather than initializing a replacement.
- [x] Module tests: both added menu/switch tests and syntax/diff checks passed. Formal browser assertions cover real fixture Session selection, return to Main/default, unavailable snapshot with zero commits and stale/closed handling.
- [x] Independent Tester: frozen formal Cloud browser passed 44 checks, including opt-in actual fixture name/map, return to default Main, missing snapshot with zero commits and retained version/URL/selection. The initial fixture waited for a correctly populated but hidden status panel; normal Settings/Recovery clicks fixed the fixture without force, additional timeout or removed assertions. Original failure is retained. Both modules passed 46/46; final Node 24.19.0 full regression passed 366/368, zero failures (340.15 seconds).
- [ ] Delivery: fresh shared artifacts, both repositories and the actual installed/Cloud versions remain separate steps; production user-session acceptance is not inferred from source checks.
- Final independent logs: `temp/tester-other-session-{modules,browser-fixed,full,slack,security}-20261005.log`. Browser approval passed 1/1; fixed installed GitHub Skill fixture 0.6.1 bidirectional sync passed 7 checks; Windows Slack passed 142/142 and security passed 39 checks. Full regression's two existing skips are browser-mode approval (separately passed here) and an unconfigured live model Provider (not exercised). Actual npm 0.6.2 user connection, offline recovery, multi-real-Session isolation and post-deployment CPU measurement remain unverified.

## AUTO-PUB-IDLE-01 · Exact-completion candidate filtering (2026-10-05)

- [x] Executor: the 30-second automatic publisher reads one project view and filters candidates using existing `sessionCompletionMatches` before status/Git inspection. Public status fields, timer cadence, Git/CI/workflow gates, transaction locks and locked rechecks are unchanged; no global cache or Slack-store changes.
- [x] Module tests: `node --test --test-name-pattern="automatic publication scan" tests/session-publication-completion.test.mjs`, 4/4 passed; final full module `node --test tests/session-publication-completion.test.mjs`, 8/8 passed (19.79 seconds). Actual scan-function tests cover one read/no status or Git-entry calls for absent and four mismatched proof fields, completed merged publication through real memory/Git gates, edit invalidation before status and after ready/before locked write; no Main/closed receipt is written in either race. Existing authority, replay, workflow-revocation lock and durable-write regressions passed unchanged.
- [x] Independent Tester: frozen-source review and final module/full regression passed. Scan tests extract the actual server function; valid publication and both invalidation races use real memory/Git/locked-write gates. The absent/stale candidate case uses fail-on-call spies. Tests inject the historical reader while the actual server uses its view-reader alias; formal browser and full runtime regressions also exercise the actual service.
- [ ] Deployment idle measurement: pre-fix production sampling motivated the change, but source passes do not establish the whole CPU root cause or a measured production improvement.
- Read-only pre-fix production observation: 881.9 seconds between samples, Cloud/Slack process CPU averaged about 14.36%/2.30% of one core. Cloud RSS was 197544→197464 KiB, Slack 129248→133836 KiB; both retained 11 threads and no service restarts. Slack state stayed 1010240 bytes but its mtime advanced. This short baseline neither proves a leak-free long run nor attributes the whole cost to publication; repeat after actual deployment before claiming improvement.

## Current implementation handoff (2026-10-05)

- [ ] SLACK-ROUTING-STEER-01: Independent Tester verifies only-other-bot silence,
  self/mixed mentions, 5–10 consecutive inputs, durable Steer, stop/resume,
  restart/deduplication, stale SSE rejection and partial-reply presentation.
  Real Slack acceptance requires reauthorization with `users:read`.
- [x] PUB-COMPLETION-01: Upload/heartbeat cannot complete a Session. Human
  completion binds Session/generation/version/source commit; edits invalidate it.
  Verify stale proof, unauthorized completion, replay, review revocation at final
  publication, existing Git/CI/experiment gates and explicit browser completion.
- [x] MEMORY-UI-01: Only project/node memory documents are editable; legacy
  memories remain readable via explicit escaped history preview. Verify no silent
  deletion/migration, attachments preserved, no extra writes and browser behavior.
- [x] RELEASE-RUNTIME-01: Publish fresh immutable Core/UI/Skill artifacts after
  security checks; update exact dependencies/integrity, generate Skill runtime,
  verify installed versions, Required checks and production revisions. Existing
  caches and source tests do not establish deployed or installed acceptance.
  Final artifact, installed-version and production evidence is recorded above;
  live Slack/user-connection acceptance remains separately open.

Each item remains in this file after completion, with its test names and evidence.
Executor implements and verifies modules; independent Tester validates the frozen
source revision. Checked source items do not establish release or production
acceptance; those remain separate gates below.

## Independent acceptance evidence, 2026-10-05

### Independent fixed-artifact/browser follow-up, 2026-10-05

The public Core/UI 1.1.0 tarballs were downloaded anonymously and matched
SHA-256 `c36415c976c3604607ba169b923f1ea27ff0790dbb56e243a09fa4278a13c51a`
and `3f041e0f348bf108b7b3d5c355beaa952e631a8273850e9db9191cf604356304`.
Actual tarball package/security checks passed (44/13 files). Public Skill 0.6.0
at `18b4e14b85970ad929a3bd1022322c074c3d58b6` matched
`75eef64293a34ac9ef57da19b41ac8da2691317a9ca98ba01e121a4b4fe0af70` and
passed its 100-file package/security contract. Node 24 isolated global/npx
installation and installed runtime passed; a real Windows Node 18 installer
failure was reported for correction and new immutable Skill 0.6.1 acceptance.
The successful source checks do not waive this installation failure.

Remote Cloud run 37266926495 failed on the second completion click. The old
fixture allowed its supposedly dirty edit to finish before clicking and checked
dialogs before the asynchronous publication request settled. An instrumented
run observed three completion requests, not the intended two. The repaired
fixture holds the real edit receipt while proving dirty completion rejection,
releases it and waits for the exact synchronized version, then tests stale 409
and accepted completion. Route removal occurs after the rejected response,
outside its active handler. Ordinary clicks, original budgets and all Main/
generation/source/authority assertions remain. The final run exited 0, with
exactly two distinct review requests; no published UI package was changed.
Evidence: `temp/tester-completion-fixture-fixed-dirty-20261005.log` and
`output/playwright/browser-ci/cloud-1791178378802-d5d8aa52-c35f-43bf-a016-e5f049b2765f`,
including `completion-requests.json`. Earlier failed logs/artifacts are retained.

The genuinely installed fixed Skill 0.6.0 passed both browser sync directions,
disk/refresh persistence, unchanged Main and server timestamps using the existing
`cloud-sync-browser.mjs` entry. Its first run timed out at the hidden Session
selector after reload; a diagnostic-only addition and unchanged-budget rerun
passed without removing that assertion. This isolated rerun does not claim the
transient timeout's root cause is resolved. Logs: `temp/tester-fixed06-sync-browser-20261005.log`
and `temp/tester-fixed06-sync-diagnosis-20261005.log`; passing artifacts:
`output/playwright/browser-ci/session-sync-1791178167683-f87f2ea1-d2e8-4214-934d-53df4dd56e71`.
New 0.6.1 fixed-artifact, remote Required, production and live Slack checks remain
separate gates; real user permissions/Hooks were not changed by isolated tests.

Final replacement artifact acceptance: public Skill 0.6.1 at
`8f144fb1de7f0de1fb024cb744fc154ea5ed834f` matched downloaded SHA-256
`0b3af28b1957a76ae763f26e1660b7c6187bae75272c91dff035f7d26cd9cf8e`
and the exact SHA-512 in the Cloud lock. Its actual 100-file package/security
contract passed. Windows Node 18.20.8 and 24.19.0 both passed the official
isolated global/npx installation and installed startup/health/assets/access
checks. Separate explicit `install --no-hooks` targets passed the same runtime
checks and `memory complete` help without creating Hook/configuration files.
The manual runtime invocation initially omitted the official isolation/ceiling
environment and was rejected; using the existing isolated environment resolved
that fixture error, not by changing the product or map assertions.

Cloud installed 0.6.1 using `npm ci --ignore-scripts` from its new exact public
URL and lock; fixture validation passed 3/3. The existing complete Session sync
browser entry then passed all seven checks on this installed package, with its
original 12/25-second budgets and reload Session-selection assertion intact.
Evidence: `temp/tester061-fixed-fixture-install-20261005.log`,
`temp/tester061-sync-browser-20261005.log`, and
`output/playwright/browser-ci/session-sync-1791178932502-cd7996cb-0f2f-443e-be78-20df7fb75d93`.
The old 0.6.0 Windows failure and first reload timeout remain recorded above;
public 0.6.0 was not overwritten. Remote Required/production/live Slack remain
separate completion gates.

### Earlier frozen-source acceptance

Input: Windows, Node 24.19.0; Cloud working tree based on `376aa151`,
Skill working tree based on `6973d182`. The fixed installed cross-repository
fixture remains Skill 0.5.0 at `6973d182`; sibling source was not substituted.
These are source/isolated-browser checks, not release, production or real Slack evidence.

- Slack: `npm test --prefix plugins/slack`, 142/142, no skips.
  Includes other-bot silence, mixed mentions, frozen stop/resume IDs,
  partial-reply slots and rejection of older input/control revisions.
- Security wrapper acceptance: `npm run security:test`, 39 checks passed.
- Steer: 10 consecutive inputs are consumed exactly once in one continuation;
  started business tools finish with durable receipts, remaining stale tools
  do not execute, and explicit resume does not repeat the completed tool.
  Source suite passed 6/6; multimodal suite passed 11/11, including a Steer
  image's summary being retained for later text-only turns.
- HTTP workbench: 36/36. New completion assertions reject project credentials,
  mismatched displayed Sessions and stale versions, then replay the exact human
  completion receipt. Publication-lock regression rejects revoked review and
  requires a durable write before reporting success.
- Browser: device approval passed; `cloud-workbench-browser.mjs` passed with
  legacy history escaping/preservation, visible partial marker, Main-hidden
  completion, dirty-edit rejection, stale-version 409, and exact completion proof.
  `cloud-sync-browser.mjs` passed both UI directions, disk/refresh persistence and
  unchanged Main using the fixed installed Skill artifact. The synthetic baseline
  now enrolls through actual `auth.open` / `session.bind` HTTP calls before
  publication; workflow-generation validation is not disabled.
- Skill source: governance passed; relevant existing modules passed 94/94.
  Added completion module covers mismatch, unbound Session, old Cloud 404,
  device 403, original-request replay and side-effect-free CLI help. No installed
  new Skill or remote release was used for this check.

The first aggregate run failed: 356 passed, 2 failed, 2 existing separate-suite
skips. One old fixture expected `NOT_MERGED` before reviewed completion;
it now completes its exact synthetic versions without weakening Git gates.
The other failure was an `archive-session` subprocess timeout. Its isolated
unchanged-deadline rerun passed (archive 22.4s, completion 24.4/24.5s);
this did not by itself make the aggregate green. Final aggregate rerun exited 0:
362 tests, 360 passed, 0 failed, 2 existing separate-suite skips, 353.57 seconds.
The previously timed-out Hook case passed in this full run (178.0 seconds);
its original subprocess deadlines and assertions were unchanged.

Logs: `temp/tester-{slack-full,cloud-security,cloud-full,cloud-full-final,
cloud-workbench-routes,hook-isolated,multimodal,steer-multi}-20261005.log`;
browser records are under `output/playwright/browser-ci/`. Earlier failures are
retained, not erased. Production reauthorization with `users:read`, immutable
artifact publication, remote Required, deployed-version checks and live Slack
acceptance remain open under RELEASE-RUNTIME-01 / SPLIT-C05 / SPLIT-C06.

Frozen runtime SHA-256:

| File | SHA-256 |
| --- | --- |
| `scripts/cloud/coordinator-service.mjs` | `f9e993fe2574cb3b03813f3b4f95579e691e0474a79b1cede9d7b8d4dc279db3` |
| `scripts/cloud/server.mjs` | `be70a65828dcbcaecb0534bb663f19e1f9872bdb67ee5f7b752a0a60070d6f4b` |
| `scripts/cloud/memory.mjs` | `e9af4bfbe08cdd8d2bfed3819ec8c89d7ea675c5c1ce9a07adbfb0ed5dceaea5` |
| `prototype/workbench-sync.mjs` | `1e6db8231cd5fde8b0992b477cc326747e64d57c419417cd5acb7efa4481e1a2` |
| `plugins/slack/src/plugin.mjs` | `345b5f58b725b27ab999ba50a430a72e67cde602c9a2ac76518226b27e30f1ef` |

- [ ] SPLIT-C01: Main and deployed Slack fixes preserved; external caller grants, pending file recovery, Slack manual items verified.
- [x] SPLIT-C02: Core/UI release artifacts contain only their allowlisted public runtime files; Skill consumers use exact versions and integrity hashes. Shared 1.1.0 scans (44/13 files), anonymous downloads and final consumer locks are recorded above.
- [x] SPLIT-C03: Cloud builds and starts without a local Skill source checkout; cross-client fixtures are development-only. Production standalone checkout/source and active formal services are recorded above.
- [ ] SPLIT-C04: Local/Cloud edits, disconnect recovery, duplicate delivery and Session isolation pass against the installed Skill artifact.
- [ ] SPLIT-C05: Real Slack project selection, reply ordering, attachments and manual brief verified without disturbing unrelated conversations.
- [x] SPLIT-C06: After explicit confirmation, removed only `/opt/context-guard-slack/candidate` and `/run/systemd/system/context-guard-slack-candidate.service`. Rechecked realpaths/inodes, mount/process/config references and that all candidate code was in live Skill Main before fd-safe deletion. Both targets are absent, unit is not-found, formal Cloud/Slack retained their PIDs and active/enabled state; health still reports `2b47df7`. Nine retained directory inodes and 27 runtime/config static-file metadata checks are unchanged. No source backup; deleted code remains recoverable from Git history. Runtime, business mirrors/data, credentials and business backups are untouched.
- [ ] SPLIT-C07: Existing data, queues, receipts and project identities remain intact; rollback source version identified without creating source backup directories. Recorded Map hashes plus Slack section counts, old IDs and thread bindings are verified above; full payload and execution-effect acceptance is not inferred from structural retention.

Known limits retained: Slack journal growth and model response latency are not
resolved by this repository split. Source tests do not establish real Slack E2E.

- [x] SPLIT-SLACK-WIN-01: Independent Tester verifies the exact frozen revision
  on Windows and Unix after the Slack Store directory-fsync boundary fix.
  Real Unix follow-up, 2026-10-05: production source at exact Main
  `2b47df759ee567e8d53f569cc56a50c19f616a47`, Node 22.23.3, passed the formal
  Store module 5/5 (174.76 ms), using only disposable OS-temp fixtures.
  Source/test bytes match the Windows-reviewed hashes below. The first case
  exercised real Linux file/directory fsync, rename, reopen and deduplication;
  the remaining platform failure cases retain injection and are not relabeled
  native Windows evidence. No production state/env/messages/services changed.
  Log: `temp/tester-slack-real-linux-store-20261005.log`. Final frozen Windows
  Node 24.19.0 full regression passed 366/368 with zero failures, including both
  named integrations; separate supported-runtime Slack suite passed 142/142
  with zero skips. These do not prove actual Slack-provider interaction.
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
  location: migrate its reference before replacing that directory. Final formal
  checkout, mirror migration, services, proxy-visible UI and recorded data hashes
  are verified above, including Slack queue/state structural retention; real Slack
  scope/E2E, full payloads and execution effects remain open rather than inferred
  from service-active or unchanged record counts.

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

- [x] SPLIT-PUBLICATION-01: Existing premature-publication risk, found by the
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
  Closed by the reviewed completion proof/common-transaction boundary under
  PUB-COMPLETION-01; the verified Cloud release above deploys that fix. Ordinary
  upload/heartbeat still cannot complete a Session. Original diagnostic history remains.

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

- [ ] MODEL-SETTINGS-01: Replace Coordinator toolbar retry/stop with model settings.
  Verify safe server-configured choices, project isolation, CAS/idempotent change,
  restart persistence, pinned active/retry routes, provider-native thinking
  boundaries, retained failure recovery and desktop/phone UI. New isolated
  suite: `tests/coordinator-model-settings.test.mjs` (8 cases); browser checks use
  synthetic provider replies and do not establish production acceptance.
  DeepSeek V4.1 Flash (`deepseek-flash`) was tested from the production host with
  private credentials: simple streamed reply first text 693 ms, and a real
  two-request `read_map` tool protocol round-trip 2,323 ms, with continuation
  first text 867 ms. The tool data in that probe was synthetic; it does not
  establish actual project Map or full Coordinator latency. No credential is
  in source, browser settings, test fixtures or logs. Required, merged source,
  production configuration and real workbench acceptance must be recorded
  separately. Independent Tester/human review remains pending.
  Local `npm test`: 381 passed, 2 existing skips; Slack: 142 passed; security:
  39 checks; targeted model/multimodal regression: 19 passed. Real Chromium
  model switching, reopen persistence and phone layout passed in the workbench
  suite. A separate initial cross-product sync run failed at the existing local
  synced-indicator assertion before any Coordinator use; retain the failure and
  rerun the unchanged full browser command rather than weakening that assertion.
