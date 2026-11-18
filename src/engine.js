import { source, index, transaction } from "./db.js";

export const batch = 32;
export function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
export async function beginGeneration(tenant, mapping) {
  return transaction(source, async (db) => {
    const {
      rows: [t],
    } = await db.query("SELECT * FROM tenants WHERE tenant=$1 FOR UPDATE", [
      tenant,
    ]);
    if (!t) throw problem(404, "Unknown workspace");
    const building = await db.query(
      "SELECT gen FROM generations WHERE tenant=$1 AND phase <> 'retired' AND gen IS DISTINCT FROM $2",
      [tenant, t.active],
    );
    if (building.rowCount)
      throw problem(409, "A generation is already building");
    const gen = t.next_generation;
    await db.query(
      "INSERT INTO generations(tenant,gen,mapping,phase,checkpoint,ceiling) SELECT $1,$2,$3,'scan',$4,coalesce(max(id),0) FROM documents WHERE tenant=$1",
      [tenant, gen, mapping, t.head],
    );
    await db.query(
      "UPDATE tenants SET next_generation=next_generation+1 WHERE tenant=$1",
      [tenant],
    );
    return gen;
  });
}

export function validateEvent(row) {
  if (
    !row ||
    row.contract !== 1 ||
    typeof row.tenant !== "string" ||
    typeof row.version !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(row.version) ||
    !row.payload ||
    row.payload.tenant !== row.tenant ||
    row.payload.version !== row.version ||
    !Number.isSafeInteger(row.payload.id) ||
    row.payload.id < 1 ||
    row.payload.id > 2147483647 ||
    typeof row.payload.title !== "string" ||
    typeof row.payload.body !== "string" ||
    !row.payload.title.length ||
    [...row.payload.title].length > 180 ||
    [...row.payload.body].length > 8192 ||
    typeof row.payload.deleted !== "boolean"
  )
    throw new Error("unsupported_change");
  return row.payload;
}
export async function project(db, g, doc, repair = false) {
  // Only the audit path may overwrite equal or corrupt future versions, under the generation lock.
  return db.query(
    `INSERT INTO projection(tenant,gen,id,version,title,body,deleted,mapping)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (tenant,gen,id) DO UPDATE SET
      (version,title,body,deleted,mapping)=(excluded.version,excluded.title,excluded.body,excluded.deleted,excluded.mapping)
    WHERE projection.version < excluded.version OR $9`,
    [
      g.tenant,
      g.gen,
      doc.id,
      doc.version,
      doc.title,
      doc.body,
      doc.deleted,
      g.mapping,
      repair,
    ],
  );
}

export async function advance(tenant, gen, afterIndexCommit) {
  return transaction(source, async (db) => {
    const {
      rows: [g],
    } = await db.query(
      "SELECT * FROM generations WHERE tenant=$1 AND gen=$2 AND phase<>'retired' AND retry_at<=now() FOR UPDATE SKIP LOCKED",
      [tenant, gen],
    );
    if (!g) return false;
    try {
      const scan = g.phase === "scan";
      const { rows } = scan
        ? await db.query(
            "SELECT * FROM documents WHERE tenant=$1 AND id>$2 AND id<=$3 ORDER BY id LIMIT $4",
            [tenant, g.scan_id, g.ceiling, batch],
          )
        : await db.query(
            "SELECT * FROM changes WHERE tenant=$1 AND version>$2 ORDER BY version LIMIT $3",
            [tenant, g.checkpoint, batch],
          );
      const docs = scan ? rows : rows.map(validateEvent);
      if (docs.length) {
        await transaction(index, async (sink) => {
          for (const doc of docs) await project(sink, g, doc);
        });
        if (afterIndexCommit) await afterIndexCommit();
      }
      const last = docs.at(-1);
      await db.query(
        `UPDATE generations SET scan_id=$3,checkpoint=$4,phase=$5,error=NULL,failures=0 WHERE tenant=$1 AND gen=$2`,
        [
          tenant,
          gen,
          scan && last ? last.id : g.scan_id,
          !scan && last ? last.version : g.checkpoint,
          scan && docs.length < batch ? "tail" : g.phase,
        ],
      );
      return docs.length > 0 || scan;
    } catch (e) {
      const code =
        e.message === "unsupported_change"
          ? "unsupported_change"
          : "index_batch_failed";
      await db.query(
        `UPDATE generations SET error=$3, failures=least(failures+1,20),
        retry_at=now()+make_interval(secs=>least(30,power(2,least(failures,5))::integer)) WHERE tenant=$1 AND gen=$2`,
        [tenant, gen, code],
      );
      console.error(
        JSON.stringify({ event: code, tenant, gen, checkpoint: g.checkpoint }),
      );
      return false;
    }
  });
}

export async function cutover(tenant, gen) {
  return transaction(source, async (db) => {
    const {
      rows: [t],
    } = await db.query("SELECT * FROM tenants WHERE tenant=$1 FOR UPDATE", [
      tenant,
    ]);
    const {
      rows: [g],
    } = await db.query(
      "SELECT * FROM generations WHERE tenant=$1 AND gen=$2 FOR UPDATE",
      [tenant, gen],
    );
    if (!g || g.phase !== "tail" || g.error || g.checkpoint !== t.head)
      throw problem(409, "Generation must reach the source head");
    if (t.active === gen) return;
    await db.query(
      "UPDATE generations SET phase='retired' WHERE tenant=$1 AND gen=$2",
      [tenant, t.active],
    );
    await db.query("UPDATE tenants SET active=$2 WHERE tenant=$1", [
      tenant,
      gen,
    ]);
  });
}
export async function audit(tenant, after, repair, expectedGeneration) {
  return transaction(source, async (db) => {
    const {
      rows: [t],
    } = await db.query("SELECT * FROM tenants WHERE tenant=$1 FOR SHARE", [
      tenant,
    ]);
    const {
      rows: [g],
    } = await db.query(
      "SELECT * FROM generations WHERE tenant=$1 AND gen=$2 FOR UPDATE",
      [tenant, t.active],
    );
    if (expectedGeneration !== undefined && expectedGeneration !== t.active)
      throw problem(409, "Generation changed. Restart the audit.");
    if (!g || g.checkpoint !== t.head)
      throw problem(409, "Wait for the active generation to catch up");
    const { rows: truth } = await db.query(
      "SELECT * FROM documents WHERE tenant=$1 AND id>$2 ORDER BY id LIMIT $3",
      [tenant, after, batch + 1],
    );
    return transaction(index, async (sink) => {
      const { rows: actual } = await sink.query(
        "SELECT * FROM projection WHERE tenant=$1 AND gen=$2 AND id>$3 ORDER BY id LIMIT $4",
        [tenant, g.gen, after, batch + 1],
      );
      const ids = [...new Set([...truth, ...actual].map((r) => r.id))].sort(
        (a, b) => a - b,
      );
      const differences = [];
      for (const id of ids.slice(0, batch)) {
        const s = truth.find((r) => r.id === id),
          d = actual.find((r) => r.id === id);
        if (
          s &&
          d &&
          ["version", "deleted", "title", "body"].every((k) => s[k] === d[k]) &&
          d.mapping === g.mapping
        )
          continue;
        differences.push({
          id,
          kind: !s ? "orphan" : !d ? "missing" : "different",
        });
        if (repair && s) await project(sink, g, s, true);
        if (repair && !s)
          await sink.query(
            "DELETE FROM projection WHERE tenant=$1 AND gen=$2 AND id=$3",
            [tenant, g.gen, id],
          );
      }
      return {
        generation: g.gen,
        checked: Math.min(batch, ids.length),
        differences,
        repaired: repair ? differences.length : 0,
        next: ids.length > batch ? ids[batch - 1] : null,
      };
    });
  });
}
