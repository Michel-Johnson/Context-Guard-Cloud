# Cloud repository

Cloud, Coordinator, Slack, common runtime and shared workbench UI are maintained
here. Skill, local runtime and client installation are maintained in the linked
Skill repository; do not copy their source into this repository.

Use platform-prefixed branches and PRs, never direct pushes to main. Preserve
security and Required checks. Runtime data and secrets never enter Git or releases.

Coordinator aligns requirements and reviews the Executor plan. Executor implements
and tests its modules, then writes numbered CI_todo items for the independent
Tester. Tester reports evidence for the exact revision, not an earlier checkout.

Do not turn production smoke tests into unapproved user messages or destructive
data changes. Do not create source backup copies; existing business data and data
backups are not source cleanup targets.
