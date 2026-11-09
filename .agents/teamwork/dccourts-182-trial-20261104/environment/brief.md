# Isolated DCCOURTS-182 validation environment

Owner: environment worker. Prepare a candidate-bound check for the DCCOURTS-182
Composer patch without changing product files, candidate worktrees, shared
services, or databases.

The frozen candidate command is `bash scripts/harness/validate-dccourts-182.sh`
from candidate root. It verifies the composer-patches registration and lock,
copies and hashes candidate patch bytes into private temporary storage, applies
the patch to pinned pristine drupal/shs 2.0.7, lints PHP, and runs an
independently hash-pinned upstream kernel test file in an isolated PHP-only
Lando service.
