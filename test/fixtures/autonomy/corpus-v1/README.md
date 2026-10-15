# AUT-05 submitted cohort v1 (rejected)

This directory preserves the original submitted JSON bytes for historical
review. It is not an accepted baseline and must not be used for AUT-01.

The original baseline manifest claims `baseline_ready`, but its evaluator
accepted false-positive result counts, incomplete review evidence, unpinned
planning output, and source identity mismatches. The current evaluator rejects
its unsupported metric-definition version, missing configuration binding,
unbound metric evidence, and stale pinned artifact digests. The lifecycle string
inside the preserved submitted manifest is not an accepted lead decision.

The corrected cohort is in `../corpus-v2/`. Its lifecycle is `captured`; the
lead's external baseline decision and independent review evidence are separate
from the immutable captured manifest.
