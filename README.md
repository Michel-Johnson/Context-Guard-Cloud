# Context Guard Cloud

Operational references: [deployment](references/cloud-deployment.md),
[Slack](references/slack-integration.md), [attachments](docs/cloud-attachments.md),
[Coordinator compaction](docs/coordinator-compaction.md).

Cloud workbench, Coordinator and integrations for Context Guard. The client and
Skill live in [Context-Guard-Skill](https://github.com/Michel-Johnson/Context-Guard-Skill).

This repository owns the Cloud service, independent Slack plugin, common runtime
package and workbench UI package. Application releases do not change project
repository identities or memory Main versions.

## Development

Install with `npm ci`. Cloud runs with `npm start`; Slack is an independent
service with its own dependencies. Configuration, credentials, maps, receipts and
attachments stay outside the checkout. See `references/cloud-deployment.md`.

`npm test` runs the Cloud tests. Cross-client tests use a pinned Skill development
dependency through a test-only package resolver; it never ships in
Cloud packages. The public packages in `scripts/shared` and `prototype` are the
only editable source of the common runtime and UI.

## Delivery

Changes go through a reviewed PR and successful CI. Executor writes numbered
`CI_todo` items after module verification; an independent Tester verifies the
exact source revision before delivery. Test completion is not human acceptance.

Deploy a Git revision into the single configured checkout. Do not create source
backup directories or permanent candidate services. Preserve live data and data
backup policy; rollback checks out a recorded source revision or release artifact.
