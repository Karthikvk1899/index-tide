# Contracts and invariants

## Why a transactional feed

The independently committed search database makes ambiguous delivery observable. The catalog is under application control, so a row trigger can capture every supported insert and update in the original transaction. A tenant clock row stays locked until commit. Writers for one tenant therefore publish versions in commit order, avoiding the gap that occurs when a sequence number is allocated before a slower transaction commits. Rollback undoes the clock increment. Different tenants have separate clock rows.

The worker needs ordered replay from one source. The PostgreSQL change table already provides that ordering, retention and a durable cursor per generation. Kafka would add an extra delivery boundary here. Redis would add another state owner without a corresponding requirement.

## Change v1

Each immutable application envelope has an integer contract, a tenant string, a database BIGINT version and a JSON payload containing tenant, positive integer id, decimal-string version, title, body and deleted. The JSON string preserves 64-bit precision in JavaScript. Only a privileged maintenance operator can mutate the change log outside the application. Physical document deletion and identity updates are rejected. Recreating a deleted ID writes a newer version to its tombstone.

## Generation lifecycle

| Phase | Work and durable progress |
|---|---|
| scan | Capture head and maximum ID under the write fence. Copy at most 32 records per transaction, remembering the last ID. |
| tail | Consume up to 32 envelopes ordered by version. Compare-and-set each projection by version, then acknowledge the batch. |
| active | A tenant pointer selects one tailing generation for search. The first generation auto-activates. Later cutovers require an operator. |
| retired | Keep the old rows readable for queries that already chose that generation. Stop advancing its checkpoint. |

A generation row lock serializes projection and repair for that generation. An interrupted sink transaction rolls back the batch. An interrupted source transaction after sink commit repeats it. Sink rows retain delete versions. A sink commit can be visible briefly before the source checkpoint acknowledges it. An index outage produces an error and exponential retry delay capped at 30 seconds. An incompatible contract blocks that generation at its previous checkpoint. Deploy a compatible decoder or restore a proven corrupted envelope through controlled maintenance. Skipping it would break completeness.

Cutover takes the tenant row lock, then the candidate generation lock. Active pointer change and retirement commit together. A writer committed before that fence must be included. A later writer becomes ordinary asynchronous lag. Under a continuously saturated writer, cutover may need a quiet interval. Each generation receives one bounded batch per worker pass. A retained live generation over 10,000 versions behind rejects the next source mutation with HTTP 503. Recovery of a stalled shadow generation matters for write availability.

Audit acquires the tenant read fence and active generation write lock. It requires the checkpoint at head. It merges the next 33 keys from both stores, compares the first 32, and returns an exclusive continuation ID. It compares version, mapping, delete flag, title and body. PostgreSQL derives the term vector from those fields. Repair reloads source values, including over an invalid future version, or removes an orphan while both fences are held. Each page is consistent with its own fence. A multi-page walk is not a global snapshot.

## HTTP v1

Use a bearer key for every route below the prefix `/api/v1`. Tenant and role come from server configuration. Unknown credentials receive 401. Reads work for both roles. All mutations require the operator role.

| Method and route | Input | Result |
|---|---|---|
| GET /status | none | Tenant, role, active pointer, source head, generation lag, progress, error class and consecutive failures |
| GET /search | q up to 160 characters, limit 1–50, offset 0–1000, optional gen | Ranked hits, generation, next offset or null |
| PUT /documents/:id | title 1–180 characters and body up to 8192 | Committed source version |
| DELETE /documents/:id | live ID | Tombstone version, or 404 |
| POST /generations | mapping 1 or 2 | Candidate number, or 409 if another build exists |
| POST /generations/:id/activate | empty JSON object | Active generation or 409 |
| POST /audit | after (exclusive ID, default 0), repair (boolean, default false), optional expected generation | Page size, generation, differences, repaired count and next ID |

Search uses plain English terms, fixed SQL, decreasing rank and increasing ID as a tiebreaker. An empty query browses by ID. Supply the returned generation on the next page. A cutover produces 409. Concurrent edits within one generation can shift offset-based pages. Deep traversal beyond the documented window requires a different interface.

Supported writes use ordinary row-level DML. Truncation, disabled triggers, direct change-table editing and superuser intervention are outside the application contract. The source and search schema migrations each run transactionally under a database-local migration lock. The databases have independent histories. Applying setup again resumes an interrupted installation.
