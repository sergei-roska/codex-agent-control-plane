# CN14 host follow-up

Own server/router/launcher-projects/host-controls/provider-identity and dedicated tests.
Root owns Git/docs; core worker owns engine/service. Preserve inherited changes.
No live services/accounts/models/targets, dependencies, Git mutations, or hostile
Git-filter regression. Disposable Git/SQLite/fake AppServer only.

First milestone: real server durable symmetric engine fence and restart downgrade
matrix, plus independent projects. Then consume stable core acceptance/close fixes.
Remaining gates: ordinary real acceptance, safe retry-close with retained locks,
authenticated steering, legacy preservation, independent review.
