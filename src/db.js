import pg from "pg";
import { readFile } from "node:fs/promises";

const options = {
  max: 6,
  connectionTimeoutMillis: 2000,
  statement_timeout: 8000,
};
export const source = new pg.Pool({
  ...options,
  connectionString: process.env.SOURCE_URL,
});
export const index = new pg.Pool({
  ...options,
  connectionString: process.env.INDEX_URL,
});
for (const pool of [source, index])
  pool.on("error", (e) =>
    console.error(JSON.stringify({ event: "idle_connection", code: e.code })),
  );

export async function transaction(pool, work) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function migrate() {
  for (const [role, pool] of [
    ["source", source],
    ["index", index],
  ]) {
    await transaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(579741)");
      await db.query(
        "CREATE TABLE IF NOT EXISTS schema_history (name text PRIMARY KEY)",
      );
      const name = role + "-001";
      if (
        !(await db.query("SELECT 1 FROM schema_history WHERE name=$1", [name]))
          .rowCount
      ) {
        await db.query(
          await readFile(
            new URL("../sql/" + name + ".sql", import.meta.url),
            "utf8",
          ),
        );
        await db.query("INSERT INTO schema_history VALUES ($1)", [name]);
      }
    });
  }
}
