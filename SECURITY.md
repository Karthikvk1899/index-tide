# Security model

The public demonstration runs on loopback and contains generated runbooks. API credentials are generated locally from 32 random bytes each, live in a mode-restricted ignored file, and are held in browser memory until disconnect or reload. The server derives tenant and privilege from a configured principal. Query parameters and request bodies cannot change the principal. Every search, checkpoint and repair query includes the tenant key. Repair and cutover require operator privilege.

| Threat | Control | Remaining exposure |
|---|---|---|
| Cross-tenant access | Server-selected tenant, composite database keys, overlapping-ID tests | Application credentials are privileged inside their database. There is no second tenant boundary using RLS. |
| Malicious document text or query | Parameterized SQL, plain term parsing, React text escaping, response CSP, bounded request bodies | Search costs depend on corpus distribution. |
| Stale events | Persistent delete versions and monotonic projection updates | Privileged database users can bypass normal controls. |
| Credential theft | Local binding, memory-only browser key, generated credentials, generic dependency errors | TLS termination, OIDC, expiry, rotation and production secret distribution need deployment work. |
| Resource exhaustion | Batch limit, backlog ceiling, connection pools, statement timeout and bounded page size | Requests lack distributed admission control. Historical storage grows. |

The operator key can change its tenant’s documents and index. Keep it out of screenshots, tickets, shell traces and shared logs. Do not publish the database ports or mount a production dataset into the demo. Before hosting, split migration and runtime roles, enforce TLS, configure network policy, rate limits, protected backups, and monitor database and worker health. Dependency audit and static rules cover selected known risks. No penetration test or independent security certification has been performed.
