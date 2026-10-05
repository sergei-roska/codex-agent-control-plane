# Local launcher

The launcher provides a local browser entry point for selecting a task repository,
starting its orchestrator, and opening a paired dashboard. It does not submit
tickets or run model work on its own.

## Start

From the application checkout:

```bash
node launcher.js
```

Keep that terminal open. The launcher opens a browser when the operating system
supports it and always prints its local URL. Paste the URL into a browser if the
automatic open fails.

Enter the absolute path of a Git project, then click **Start server**. The
dashboard opens after startup with a fresh browser session. Use **Open dashboard**
to open it again or pair another browser. There is no terminal pairing command
in this flow.

**Stop server** stops the launcher-owned orchestrator. Stop active model work
through the dashboard first if you intend to preserve it for continuation: a
clean server stop cancels executing runs. Closing a browser tab does not stop the
launcher or the orchestrator. `Ctrl+C` in the launcher terminal closes both.

## Projects and state

The launcher remembers recently used repositories and runs one project server at
a time. Stop it before selecting another project. State is stored under
`.runtime/launcher/projects/` using the canonical repository path as its identity;
two repositories with the same directory name have separate state.

The launcher detects an initial base branch and saves it in that project's
`project.json`. An existing policy is preserved on later starts. It does not
invent approved acceptance checks or change repository branches.

Launcher-managed state is separate from earlier manually configured instances,
including `.runtime/state.sqlite` and `.runtime/dccourtscode/`. Existing manual
data is not moved, overwritten, or deleted.

Launcher servers use the default shared Git common-directory workspace lock.
Do not run a manually configured server for the same repository with a custom
`CODEX_A2A_WORKSPACE_LOCK_DIR`: that override creates a separate lock domain.
Stop such an instance before starting the project through the launcher.

## Requirements and errors

- Dependencies must be installed (`npm ci` after a fresh checkout).
- Codex must be signed in with ChatGPT (`codex login status`).
- The task repository must exist outside the application checkout.
- An occupied dashboard port does not authorize stopping its existing process.
  Stop that server yourself or choose another port under **Advanced settings**.
- The default dashboard port is 3000. Atlassian OAuth needs the port configured
  in its registered redirect URL; changing the port does not change that setup.
- The launcher and stored dashboard views are local. OpenAI model work and
  external integrations still require Internet access.

## Local security boundary

Both servers bind to loopback. The launcher validates its Host and mutation
Origin and requires a random, process-local request token from its own page.
Pairing URLs are returned only for explicit start/open actions, not in status
polling or recent-project storage. The browser receives a pairing URL rather
than the dashboard bearer token.
