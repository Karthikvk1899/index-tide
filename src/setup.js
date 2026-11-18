import { migrate, source, index, transaction } from "./db.js";
import { beginGeneration } from "./engine.js";
await migrate();
const topics = [
  [
    "Rollout checklist",
    "Verify readiness probes, then advance the canary and review error budgets.",
  ],
  [
    "Replica recovery",
    "Restore the standby, inspect replication lag, and confirm the recovery point.",
  ],
  [
    "Search relevance",
    "Compare ranked results for common queries against the review set.",
  ],
  [
    "Queue saturation",
    "Reduce ingestion concurrency and measure the oldest pending change.",
  ],
  [
    "Schema migration",
    "Build a shadow projection, validate its mapping, and switch readers.",
  ],
  [
    "Certificate rotation",
    "Stage a new certificate and verify clients before retiring the previous key.",
  ],
];
for (const tenant of ["estuary", "upland"]) {
  await transaction(source, async (db) => {
    const created = await db.query(
      "INSERT INTO tenants(tenant) VALUES ($1) ON CONFLICT DO NOTHING RETURNING tenant",
      [tenant],
    );
    if (!created.rowCount) return;
    for (let i = 0; i < 48; i++) {
      const [title, body] = topics[i % topics.length];
      await db.query(
        "INSERT INTO documents(tenant,id,title,body) VALUES ($1,$2,$3,$4)",
        [
          tenant,
          i + 1,
          title + " · " + (Math.floor(i / topics.length) + 1),
          body,
        ],
      );
    }
  });
  if (
    !(await source.query("SELECT 1 FROM generations WHERE tenant=$1", [tenant]))
      .rowCount
  )
    await beginGeneration(tenant, 1);
}
await Promise.all([source.end(), index.end()]);
