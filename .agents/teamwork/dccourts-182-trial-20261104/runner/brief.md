# DCCOURTS-182 project-run adapter

This directory contains the task-specific runner for the isolated DCCOURTS-182
trial. It reads the sibling task-input.json and uses its exact goal, acceptance
contract, budgets, and role overrides. It never initializes or changes target
Git state. The runner does not access the original project checkout or project
services.

Run a read-only readiness check from the harness root:

```sh
node .agents/teamwork/dccourts-182-trial-20261104/runner/run-dccourts-182.js --preflight
```

The native mode is intentionally explicit and requires root GO:

```sh
node .agents/teamwork/dccourts-182-trial-20261104/runner/run-dccourts-182.js --run
```

Native-mode results and the candidate diff/patch are written only under this
directory. A failed runtime close retains its private state directory and
reports it with recorded process identities; it does not claim cleanup.
