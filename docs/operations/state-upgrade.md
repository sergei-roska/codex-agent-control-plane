# State upgrade, backup and restore

Applies from M2. The server keeps all durable state in one SQLite file plus an
attachment directory next to it.

| Item | Default location | Override |
| --- | --- | --- |
| State database | `.runtime/state.sqlite` (with `-wal`/`-shm` side files) | `CODEX_A2A_STATE_DB` |
| Attachment bytes | `<state dir>/artifacts/` | `CODEX_A2A_ARTIFACT_DIR` |
| A2A token | `.runtime/a2a-token` | `CODEX_A2A_TOKEN_FILE` |

## Upgrading

1. Stop the server (Ctrl+C or SIGTERM) and wait for it to exit; it holds an exclusive
   lock on the state file.
2. Update the code (`git pull`, `npm ci`).
3. Start the server. Pending product schema migrations run at startup, before any request
   is served. When the database already had tables, the server first writes a backup
   `<state file>.bak-v<previous version>-<UTC timestamp>` (mode 0600) and prints its path.
4. If startup fails, nothing was migrated past the last successful migration: each
   migration is a single transaction. Fix the reported problem, or restore (below).

A database created by newer code (a higher product schema version than the running code
knows) is refused at startup; the server does not downgrade.

The backup contains the database only. Attachment bytes are immutable and are never
rewritten by migrations, so they need no migration backup; include the attachment
directory in any regular backup of your own.

## Manual backup

With the server stopped, copy the state file (and its `-wal` file if present) and the
attachment directory. With the server running, use `sqlite3 .runtime/state.sqlite ".backup
'/path/backup.sqlite'"` instead of a plain file copy.

## Restoring

1. Stop the server.
2. Move the current `state.sqlite`, `state.sqlite-wal` and `state.sqlite-shm` aside
   (do not delete them until the restore is verified).
3. Copy the chosen backup to the state file path, then `chmod 600` it.
4. Start the server with the code version that matches the backup, or a newer one,
   which migrates it again.

Tickets, revisions and attachment metadata created after the backup are not in the
restored database. Their attachment files remain on disk as orphans. They are harmless,
and M2 never deletes them.
