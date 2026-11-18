import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { source, index, transaction } from "./db.js";
import { audit, beginGeneration, cutover, problem } from "./engine.js";
const digest = (value) => createHash("sha256").update(value).digest();
const positive = { type: "integer", minimum: 1, maximum: 2147483647 };
const integer = (value, min, max) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw problem(400, "Invalid number");
  return n;
};
export function app(keys) {
  if (
    keys.some((k) => typeof k.token !== "string" || k.token.length < 32) ||
    new Set(keys.map((k) => k.token)).size !== keys.length
  )
    throw new Error("Supply distinct generated keys");
  const principals = keys.map(({ token, ...p }) => ({
    ...p,
    hash: digest(token),
  }));
  const api = Fastify({
    bodyLimit: 40000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  api.setErrorHandler((e, req, reply) => {
    if (e.code === "P5501")
      return reply
        .code(503)
        .header("Retry-After", "5")
        .send({ error: "Projection backlog is full" });
    const status = e.statusCode || 503;
    if (status >= 500) req.log.error({ code: e.code }, "dependency failure");
    reply
      .code(status)
      .send({ error: status >= 500 ? "Dependency unavailable" : e.message });
  });
  api.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
      );
    return payload;
  });
  api.register(staticFiles, {
    root: fileURLToPath(new URL("../dist/", import.meta.url)),
  });
  api.get("/health/live", async () => ({ live: true }));
  api.register(
    async (routes) => {
      routes.addHook("onRequest", async (r) => {
        const auth = r.headers.authorization || "";
        const p =
          auth.startsWith("Bearer ") &&
          principals.find((k) =>
            timingSafeEqual(k.hash, digest(auth.slice(7))),
          );
        if (!p) throw problem(401, "Enter a valid workspace key");
        if (r.method !== "GET" && p.role !== "operator")
          throw problem(403, "Operator access required");
        r.principal = p;
      });
      routes.get("/status", async (r) => {
        const { tenant, role } = r.principal;
        const { rows } = await source.query(
          `SELECT t.active,t.head,g.gen,g.mapping,g.phase,g.checkpoint,g.scan_id,g.ceiling,g.error,g.failures,
      (t.head-g.checkpoint)::text AS lag FROM tenants t LEFT JOIN generations g USING(tenant)
      WHERE t.tenant=$1 AND g.phase<>'retired' ORDER BY g.gen`,
          [tenant],
        );
        return { tenant, role, generations: rows };
      });
      routes.get("/search", async (r) => {
        const { tenant } = r.principal;
        const q = String(r.query.q || "").trim();
        if (q.length > 160) throw problem(400, "Query exceeds 160 characters");
        const offset = integer(r.query.offset ?? 0, 0, 1000);
        const limit = integer(r.query.limit ?? 12, 1, 50);
        const {
          rows: [t],
        } = await source.query("SELECT active FROM tenants WHERE tenant=$1", [
          tenant,
        ]);
        if (!t.active) throw problem(409, "Initial index is building");
        if (
          r.query.gen !== undefined &&
          integer(r.query.gen, 1, 2147483647) !== t.active
        )
          throw problem(409, "Generation changed. Restart search.");
        const { rows } = await index.query(
          `WITH query AS (SELECT plainto_tsquery('english',$3) AS term)
    SELECT id,title,body,version,ts_rank_cd(terms,term) AS score FROM projection,query
    WHERE tenant=$1 AND gen=$2 AND NOT deleted AND ($3='' OR terms @@ term)
    ORDER BY score DESC,id LIMIT $4 OFFSET $5`,
          [tenant, t.active, q, limit + 1, offset],
        );
        return {
          generation: t.active,
          items: rows.slice(0, limit),
          next:
            rows.length > limit && offset + limit <= 1000
              ? offset + limit
              : null,
        };
      });
      const params = {
        type: "object",
        properties: { id: positive },
        required: ["id"],
      };
      routes.put(
        "/documents/:id",
        {
          schema: {
            params,
            body: {
              type: "object",
              required: ["title", "body"],
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 180 },
                body: { type: "string", maxLength: 8192 },
              },
            },
          },
        },
        async (r) => {
          const { tenant } = r.principal,
            { id } = r.params,
            { title, body } = r.body;
          return transaction(source, async (db) => {
            await db.query("SELECT 1 FROM tenants WHERE tenant=$1 FOR UPDATE", [
              tenant,
            ]);
            const updated = await db.query(
              "UPDATE documents SET title=$3,body=$4,deleted=false WHERE tenant=$1 AND id=$2 RETURNING version",
              [tenant, id, title, body],
            );
            if (updated.rowCount) return updated.rows[0];
            return (
              await db.query(
                "INSERT INTO documents(tenant,id,title,body) VALUES($1,$2,$3,$4) RETURNING version",
                [tenant, id, title, body],
              )
            ).rows[0];
          });
        },
      );
      routes.delete("/documents/:id", { schema: { params } }, async (r) => {
        const {
          rows: [doc],
        } = await source.query(
          "UPDATE documents SET deleted=true,title='Deleted',body='' WHERE tenant=$1 AND id=$2 AND NOT deleted RETURNING version",
          [r.principal.tenant, r.params.id],
        );
        if (!doc) throw problem(404, "Document unavailable");
        return doc;
      });
      routes.post("/generations", async (r) => ({
        generation: await beginGeneration(
          r.principal.tenant,
          integer(r.body?.mapping, 1, 2),
        ),
      }));
      routes.post(
        "/generations/:id/activate",
        { schema: { params } },
        async (r) => {
          await cutover(r.principal.tenant, r.params.id);
          return { activated: r.params.id };
        },
      );
      routes.post("/audit", async (r) =>
        audit(
          r.principal.tenant,
          integer(r.body?.after ?? 0, 0, 2147483647),
          r.body?.repair === true,
          r.body?.generation === undefined
            ? undefined
            : integer(r.body.generation, 1, 2147483647),
        ),
      );
    },
    { prefix: "/api/v1" },
  );
  return api;
}
