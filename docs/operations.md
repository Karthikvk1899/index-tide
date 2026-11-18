# Operations

Run `docker compose ps` to inspect the two databases and processes. `GET /health/live` checks the HTTP process. The authenticated status route reads the source even while search is unavailable. A nonzero lag counts committed versions after the generation checkpoint. A scan-phase generation can have zero change lag while its initial copy is incomplete. Monitor phase, scan cursor, checkpoint, error class and retry count together. The worker logs structured error events with tenant and generation. On-call consumers should also monitor free space on both volumes.

## Exercise a repair

After first activation, stop changing documents. Simulate loss of one generated index entry in the local demo.

```sh
docker compose exec -T search psql -U tide -d tide -c \
  "DELETE FROM projection WHERE tenant='estuary' AND gen=1 AND id=4"
```

In **Index operations**, audit the first page. Runbook 4 appears as missing. Repair the page, then audit it again. Repair rechecks live state under the same locks as audit and returns how many rows it changed. An orphan is an index key with no catalog row. A tombstone is legitimate catalog state. The console reports the generation for each audit page.

## Recovery

| Symptom | Procedure |
|---|---|
| Search returns 503 | Check search database connectivity and disk. Source acceptance continues up to the backlog limit. Restore search and watch the checkpoint advance. |
| Index batch failed | Inspect search database errors and connectivity. Retries preserve the previous checkpoint. |
| Unsupported change | Identify the first unapplied batch after the checkpoint, inspect its contract, and deploy decoder support. Keep the checkpoint intact. |
| Rebuild stalled | Inspect the shadow generation and its errors. Repair the dependency or decoder before reaching the write threshold. |
| Cutover returns 409 | Check phase and source head. Retry when caught up. Existing readers continue using the active generation. |
| Search volume lost | Reapply the index migration using setup, build a fresh generation, and activate at head. The previous active generation can serve incomplete results until cutover. |
| Restore from backup | Restore the authoritative source including clock, tombstones and feed. Rebuild search into a fresh generation. Verify all audit pages during a write pause. |

Shut down with `docker compose down`. Volumes survive. `docker compose down -v` permanently removes demo data. This release retains changes, tombstones and retired projections. Plan storage and retention before deploying it for sustained ingestion. Do not prune feed entries needed by a live checkpoint. Recovery from arbitrary changes to internal PostgreSQL indexes requires database-level integrity tooling.
