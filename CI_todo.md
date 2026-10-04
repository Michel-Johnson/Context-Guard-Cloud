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
