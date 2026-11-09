# CN-09 continuation

Complete only the existing delivery inbox, lead planner and project delivery
controller implementation in assigned source and test files. Use actual
BacklogStore and TaskScheduler integration fixtures; fake runTurn/provider/exec
boundaries only. Preserve shared changes and do not edit backlog, scheduler,
executor, candidate or legacy files.

Required evidence: immediate durable acknowledgement during a slow worker;
owner steering and authenticated owner corrections before relevant claims;
strict captured revision validation; durable same-provider-thread fence;
lost-wakeup/restart behavior; message apply/ack atomicity or pinned replay;
coalesced triggers with no idle model loop; bounded investigate/replan/recovery
metadata without model fallback. Keep capacity and terminal controls enforced
during errors and restart. Caller flags and source strings do not grant owner
authority. No live model, network, service, account, Git or target action.

Coordinate missing interface needs with root. Run focused affected tests and
syntax checks, then freeze for independent review/challenge. Root owns Git/docs.
