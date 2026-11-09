# DCCOURTS-182 bounded live Harness trial

Owner: root. User authorized 2026-11-04: repeat the already completed ticket
from dccr-master in a test branch, then undo the test patch. This extends the
isolated Concurrent smoke with a real project objective.

## Verified baseline and isolation

- Original project: /home/sr/Projects/dccourtscode, branch bugfix/DCCOURTS-182,
  HEAD 41d8ecde87bd163585327c13e1a95fc777df3c27. Preserve the original checkout,
  its installed dependencies, and untracked specs/DCCOURTS-182.requirements.yml.
- Trial worktree: /home/sr/Projects/dccourtscode-harness-trial-20261104.
  Test branch: test/harness-DCCOURTS-182-20261104.
  Baseline: dccr-master 4b526e7e3e4f727c99f02fd44a655df595adfe0c.
- Keep the existing implementation as evaluator holdout. Do not feed its patch
  or branch contents to planner/engineer. Public ticket/upstream sources are
  legitimate inputs. No comparison savings claim from this single case.
- Harness services, settings, state, token and output storage must be private
  to the trial. Existing launcher/projects and old planner turn remain excluded.

## Task scope

Source: https://insomniacdesign.atlassian.net/browse/DCCOURTS-182, fetched through
the Atlassian connector with its three comments on 2026-11-04.

SHS 2.0.7 no longer preselects saved Forms field_form_category values when
editing; saving without reselecting clears the stored reference. Apply the
upstream issue 3620147 fix using composer-patches, preserving drupal/shs 2.0.7.
The ticket identifies upstream merge request !59. Verify selected existing
category preservation and deleted-reference behavior to the extent the isolated
test environment supports it. Do not directly edit contributed module files as
the deliverable; use a tracked Composer patch and lock metadata.

Production followups (restore category on node 5415289 after deployment, audit
production Forms changed after 2026-10-28, Jira transition) are outside this
authorized test trial. Record them as excluded and do not claim whole-ticket
acceptance. No SQL dumps, production access, remote writes or Jira changes.

## Project constraints

Read the original AGENTS.md before work. Development commands use Lando.
Never read SQL dumps. No unrelated configuration/content changes. The referenced
root spec-start-ticket.md and spec-model-selection.md are absent; this brief
pins the already-authorized repeat-trial scope and does not authorize guessing
their contents. Original requirements YAML is context only, not a file to edit.

## Acceptance and cleanup

1. First finish the separate isolated startup/synthetic smoke prerequisite.
2. Run the code objective through the actual Concurrent Harness/native provider,
   preserving exact input/source/model/settings and durable result evidence.
3. Independently validate the generated diff and checks; distinguish static,
   unit/kernel and browser/content checks and retain unknowns.
4. Save result patch, check logs and usage evidence before undoing owned test
   changes. Stop the isolated service safely. Restore the test branch/worktree
   to its recorded baseline without changing the original checkout or patch.
5. Record acceptance limitations and independent critic verdict. No deployment,
   generalized live qualification or measured savings claim.

## Ownership

Root: Git owner, task protocol, Harness task admission, final evaluation/cleanup.
Environment worker: private Lando configuration and independent validation
scripts/dependencies only. It must not implement the ticket or inspect holdout.
Synthetic smoke worker: private Harness probe script/evidence; later trial
adapter only after root provides the task contract and check command.
