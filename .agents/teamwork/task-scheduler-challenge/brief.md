# CN-08 scheduler challenge

Scope: owned notes and disposable SQLite/fake executor probes only. No reviewed source edits.
Primary attack: two schedulers using lower runtime capacity than persisted store ceiling race before the claim transaction.
