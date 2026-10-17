# AUT-03 cohort stop report

On 2026-10-17 the revised skill-off cohort began after independent approval of
the direct pinned App Server controls. The first `pilot-price-f2` task completed
in 31.525 seconds with one lead turn. The next `bounded-dependencies` task
completed in 129.164 seconds but recorded four `lead_turn` rows. The frozen
maximum was three lead model turns per task, so this was a protocol deviation.

The usage ledger recorded 107,421 total tokens for the second task. Its
`modelRequests` field was null; the four `lead_turn` rows correspond to four
App Server `turn/start` submissions. The task used no worker dispatches, had no
permission events, and left its workspace empty and read-only. The trial server
was stopped and `baselineCaptureAllowed` was closed at 2026-10-17T05:42:43Z.

The second task and the earlier task from this incomplete cohort are excluded
from final scoring. Their outputs remain preserved under
`live-trial/revised-cohort/skill-off/`. The tracked trial wrapper now caps
`turn/start` submissions at three and stops before submitting a fourth. That
control requires independent review before a fresh cohort can start from a new
skill-off `pilot-price-f2` task.

At stop time the launcher system Team account had 33 percent primary usage and
84 percent weekly usage, with automatic switching disabled. The protected
launcher-managed project on port 3002 remained running and untouched.
