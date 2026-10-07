# Cloud deployment

Deploy Cloud only from [Context-Guard-Cloud](https://github.com/Michel-Johnson/Context-Guard-Cloud).
Skill and its local backend are released independently from Context-Guard-Skill.
Do not run a Skill checkout as the Cloud service or retain parallel candidate
source trees. Cloud and Slack share one approved Cloud source revision, but run
as separate services with separate dependencies and state.

Private memory authority and publication are defined in
[server-memory.md](../scripts/shared/references/server-memory.md).
Installing Cloud alone does not migrate Session data or change project identity.

## 1. Installation layout

The templates use Linux systemd **system** services under the `context-guard`
account. Create this dedicated account before installing the units. Cloud requires
Node.js >= 18; Slack requires its own Node.js >= 22.19.0 and npm >= 9.6.4.

| Purpose | Path |
| --- | --- |
| Only Cloud source checkout | `/opt/context-guard-cloud/repository` |
| Cloud protected environment | `/etc/context-guard-cloud/cloud.env` |
| Optional existing site overrides | `/etc/context-guard-cloud/public.env` |
| Private memory configuration | `/etc/context-guard-cloud/memory.json` |
| Cloud business data | `/var/lib/context-guard-cloud` |
| Private memory data, for a new installation | `/var/lib/context-guard-cloud/memory` |
| Business-project Git mirrors | `/var/lib/context-guard-projects/<project>` |
| Slack source | `/opt/context-guard-cloud/repository/plugins/slack` |
| Slack protected environment / state | `/etc/context-guard-slack.env` / `/var/lib/context-guard-slack` |
| Slack Node runtime | `/opt/context-guard-slack/runtime/bin/node` |

These are installation defaults, not a data migration command. On an existing
host retain the verified data/configuration paths and adjust the unit's
`ReadWritePaths` if needed. Do not move or replace data just to match a template.

For a new installation, an administrator installs Git, Node, npm, curl and the
service account, then creates the only checkout:

```bash
sudo git clone https://github.com/Michel-Johnson/Context-Guard-Cloud.git /opt/context-guard-cloud/repository
cd /opt/context-guard-cloud/repository
sudo npm ci --omit=dev --ignore-scripts
```

Select the reviewed release commit before starting services. The service account
needs read access to code and protected JSON files, but no write access to source.
Runtime state and credentials must stay outside the checkout.

## 2. Protected configuration and project mirrors

Create the writable business-mirror root before starting the system unit:

```bash
sudo install -d -o context-guard -g context-guard -m 0750 /var/lib/context-guard-projects
```

The service allows writes to this directory for Git fetches and explicitly
enabled project-file operations; the Cloud application's own checkout stays
read-only. Existing mirrors elsewhere need their exact directory in a reviewed
`ReadWritePaths` override until migrated. Never grant write access to `/opt` or `/`.

Create `/etc/context-guard-cloud/cloud.env` with mode `0600`, root-owned.
Systemd reads the EnvironmentFile before changing to the service account:

```dotenv
CONTEXT_GUARD_CLOUD_TOKEN=<independent-admin-token>
CONTEXT_GUARD_CLOUD_WORKBENCH_TOKEN=<independent-browser-token>
CONTEXT_GUARD_CLOUD_PASSWORD_HASH=<scrypt-password-hash>
CONTEXT_GUARD_CLOUD_ORIGIN=https://map.example.com
CONTEXT_GUARD_MEMORY_CONFIG=/etc/context-guard-cloud/memory.json
```

Never put real credentials in Git, command arguments, Maps or copied logs.
Generate independent tokens with a password manager. Generate the salted password
hash through private standard input, without placing the password in shell history:

```bash
node --input-type=module -e '
  import { createWorkbenchPasswordHash } from "./scripts/cloud/server.mjs";
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  process.stdout.write(await createWorkbenchPasswordHash(password.replace(/\r?\n$/, "")) + "\n");
'
```

Cloud stores the hash, not the password. Human login creates the existing
HttpOnly/SameSite browser cookie. Execution clients normally use browser-approved
device authorization, not project-token or password copying.

Create the protected memory JSON with mode `0600`, readable by the service
account, for example owned by `context-guard`. Paths are absolute:

```json
{
  "dataDir": "/var/lib/context-guard-cloud/memory",
  "adminToken": "<server-only-memory-admin-token>",
  "projects": {
    "my-project": {
      "token": "<project-memory-token>",
      "root": "/var/lib/context-guard-projects/my-project",
      "ref": "refs/remotes/origin/main",
      "repository": "owner/my-project"
    }
  }
}
```

Each `root` is that **business project's** independently maintained Git checkout
or mirror. It is not the Cloud application repository unless Cloud itself is the
business project. Fetch its authoritative Main as a deployment/maintenance step.
The service verifies source commits against that ref; it must not substitute the
Cloud release SHA for the project's Main SHA.

The template uses `ProtectSystem=strict`. Omit the memory project's `remote`
field so the running service does not attempt a fetch into read-only code/mirrors.
Do not grant source write access to work around publication failures.

For Slack, configure its optional loopback gateway and independent secret as in
[slack-integration.md](slack-integration.md). Slack SDK dependencies remain in the
plugin package; Cloud does not load them.

### Coordinator model selection

The workbench's **模型配置** button selects a server-configured text provider for
the current project. Keep `coordinator.providerFile` as the original provider for
legacy in-flight turns and retries. Add an explicit private catalog, for example:

```json
{
  "modelProviders": {
    "glm-5.3": { "label": "GLM 5.3", "providerFile": "/etc/context-guard-cloud/glm-coordinator.json" },
    "deepseek-flash": { "label": "DeepSeek V4.1 Flash", "providerFile": "/etc/context-guard-cloud/deepseek-flash-coordinator.json" }
  },
  "defaultProviderId": "deepseek-flash"
}
```

Each provider file is `0600`, readable by the service account and outside Git.
DeepSeek V4.1 Flash uses `model: "deepseek-flash"`, `protocol: "anthropic"`,
`baseUrl: "https://api.deepseek.com/anthropic"` and a private `token`.
Validate streaming and a tool continuation with the actual credentials before
opening the option. Never enter credentials in browser fields or URLs.

`GET/POST /api/workbench/projects/<project>/api/coordinator/model` requires
workbench authority. POST accepts only `{id, providerId, baseVersion}` and saves
versioned, idempotent selection under the project's Coordinator data directory.
The browser receives only IDs, labels, model names and a settings version.
Changes apply to subsequent text turns, including Slack, not in-flight turns or
their retries. Image routing is unchanged. Retain all original providers until
their unfinished turns are resolved. Removing a selected provider fails closed.

## 3. Start and connect

The Cloud template listens on `127.0.0.1:8788`, uses private mode and secure cookies.
Terminate TLS at a reverse proxy; never expose the backend port publicly.
If an existing container proxy requires a specific private bridge address, retain
that reviewed host override and firewall boundary. Do not blindly replace it with
loopback or `0.0.0.0` during migration. Set the exact external HTTPS origin.

```bash
sudo install -o root -g root -m 0644 deploy/context-guard-cloud.service /etc/systemd/system/context-guard-cloud.service
sudo systemctl daemon-reload
sudo systemctl enable --now context-guard-cloud.service
curl --fail http://127.0.0.1:8788/api/health
sudo systemctl show context-guard-cloud.service -p WorkingDirectory -p ExecStart -p MainPID -p ExecMainStartTimestamp
```

Use the actual private bind address for the local health probe if it differs.
Check the running entrypoint and source revision as well as health; a live process
or a checkout SHA alone does not prove that the latest code is loaded. Inspect
private diagnostics without copying credentials, prompts or full journal contents.

An administrator enrolls business projects in the existing project directory and
memory configuration. Preserve existing IDs during the split; do not create new
projects merely because the Cloud source repository changed. Administrative and
project API credentials use Authorization headers, not query strings.

Working copies use the installed Skill:

```bash
context-guard workbench connect --root <project> --url https://map.example.com --session <actual-session-id> --wait
context-guard workbench --root <project> --session <actual-session-id>
context-guard sync status --root <project> --session <actual-session-id>
```

The human approves the returned browser URL/code; the backend stores the device
credential. New Sessions reuse the project connection. The old Map-only transport
has been removed. `UPGRADE_REQUIRED` with pending old data is a reconciliation
blocker, not permission to erase queues or overwrite Main.

Install Slack following its [README](../plugins/slack/README.md), then check both
its initial Socket readiness and a real authorized Slack interaction. Cloud
health does not establish Slack readiness.

## 4. Upgrade, source retirement and rollback

1. Record the currently running Cloud/Slack source SHA and their data/config paths.
   Back up **business data and protected configuration** using the established
   policy. Include private memory, attachments and Slack state/receipts.
   Do not archive or copy the source checkout.
2. Fetch the Cloud repository and select the exact approved release commit. Stop
   Slack before Cloud, install root production dependencies and the plugin's
   independent dependencies, then start Cloud followed by Slack.
3. Verify entrypoints, process generations and source SHA; perform authenticated
   read/edit/reload, preserved Session history, reconnect, and Slack readiness.
   An edit requires an approved test project, not an arbitrary production Map.
4. Update clients to the compatible Skill release. Verify the installed entry,
   local/Cloud synchronization and preserved pending data.
5. Retire obsolete units, overrides and source directories only after confirming
   no process, service or business-project mirror still references them; unique
   commits must already be in Git and runtime data must already be outside them.
   Keep a single fixed source entrypoint. Do not create `*-old` source copies.

A dirty source checkout is a deployment blocker; do not `reset --hard`, overwrite
uncommitted changes or promote a candidate directory as a second permanent source.
Use Git history or the approved release artifact to redeploy a previous compatible
version at the same entrypoint. Preserve the current business data and receipts.
If a release requires incompatible data migration, stop for an explicit migration
and recovery plan; a source rollback must not silently restore stale data.

## 5. Business-data backup retention

Keep the existing data/credential backup mechanism. New snapshots exclude source,
`node_modules`, candidate checkouts and runtime binaries. Record the corresponding
release SHA as small metadata. Do not delete old mixed archives as source cleanup;
they may contain the only copy of business data.

`deploy/prune-cloud-backups.mjs` retains the five newest complete snapshots from
`/var/backups/context-guard-cloud-pre-*.tar[.zst]` or
`/var/backups/context-guard-cloud/pre-*`. It defaults to dry-run, verifies retained
snapshots, refuses changed inventories/symlinks, and waits ten minutes after recent
backup changes. It does not create backups. Keep the existing backup producer
configured for data and protected configuration.

Install the reviewed retention script and units as **root-owned** files; never
execute a service-writable checkout script as root:

```bash
sudo install -D -o root -g root -m 0755 deploy/prune-cloud-backups.mjs /usr/local/libexec/context-guard-cloud-prune.mjs
sudo install -D -o root -g root -m 0644 deploy/context-guard-cloud-backup-retention.service /etc/systemd/system/context-guard-cloud-backup-retention.service
sudo install -D -o root -g root -m 0644 deploy/context-guard-cloud-backup-retention.timer /etc/systemd/system/context-guard-cloud-backup-retention.timer
sudo systemctl daemon-reload
sudo node /usr/local/libexec/context-guard-cloud-prune.mjs
sudo systemctl enable --now context-guard-cloud-backup-retention.timer
```

Create data archives with mode `0600` under a `.part` name, verify their complete
contents, then atomically rename to the recognized final name. Retention integrity
checks do not replace checking that all required data/configuration was included.
Existing data/config directories and archives remain governed by this retention
policy, not by source cleanup.

For a host move, stop writes and copy the complete business-data/state directories
and protected configuration. Deploy the same approved Cloud version from Git,
verify history and readiness, then reconnect clients with `workbench connect`.
Never reconstruct synchronization state from the latest Map alone.
