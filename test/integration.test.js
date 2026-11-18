import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { migrate, source, index, transaction } from "../src/db.js";
import {
  advance,
  project,
  beginGeneration,
  cutover,
  audit,
} from "../src/engine.js";
import { app } from "../src/api.js";

const tenant = "test-" + randomBytes(6).toString("hex"),
  other = tenant + "-other";
const principals = [
  [tenant, "operator"],
  [tenant, "reader"],
  [other, "operator"],
].map(([tenant, role]) => ({
  tenant,
  role,
  token: randomBytes(32).toString("hex"),
}));
const api = app(principals);
const call = (path, method = "GET", payload, principal = 0) =>
  api.inject({
    method,
    url: "/api/v1/" + path,
    headers: { authorization: "Bearer " + principals[principal].token },
    payload,
  });
const doc = (id, title = "Replica recovery") =>
  call("documents/" + id, "PUT", { title, body: "Recover the service" });
const genState = async (gen) =>
  (
    await source.query("SELECT * FROM generations WHERE tenant=$1 AND gen=$2", [
      tenant,
      gen,
    ])
  ).rows[0];
after(async () => {
  await api.close();
  await Promise.all([source.end(), index.end()]);
});
test("projection lifecycle across two independent PostgreSQL databases", async (t) => {
  await migrate();
  await source.query("INSERT INTO tenants(tenant) VALUES($1),($2)", [
    tenant,
    other,
  ]);
  for (let i = 1; i <= 40; i++) assert.equal((await doc(i)).statusCode, 200);
  const g = await beginGeneration(tenant, 1);
  await t.test(
    "backfill handoff covers edits behind cursor, deletes ahead, and inserts above ceiling",
    async () => {
      await advance(tenant, g);
      assert.equal((await genState(g)).scan_id, 32);
      await doc(1, "Checkpoint handbook");
      await call("documents/39", "DELETE");
      await doc(80, "Checkpoint entries");
      await advance(tenant, g);
      await assert.rejects(cutover(tenant, g), /reach/);
      await advance(tenant, g);
      await cutover(tenant, g);
      const search = await call("search?q=checkpoint");
      assert.equal(search.statusCode, 200);
      assert.deepEqual(
        search
          .json()
          .items.map((x) => x.id)
          .sort((a, b) => a - b),
        [1, 80],
      );
      assert.equal(
        (
          await index.query(
            "SELECT deleted FROM projection WHERE tenant=$1 AND gen=$2 AND id=39",
            [tenant, g],
          )
        ).rows[0].deleted,
        true,
      );
    },
  );
  await t.test(
    "tenant keys and operator privileges constrain reads and writes",
    async () => {
      assert.equal((await api.inject("/api/v1/search")).statusCode, 401);
      assert.equal(
        (await call("documents/1", "DELETE", undefined, 1)).statusCode,
        403,
      );
      assert.equal(
        (await call("audit", "POST", { repair: true }, 1)).statusCode,
        403,
      );
      await call(
        "documents/1",
        "PUT",
        { title: "Privateultramarine", body: "Other workspace" },
        2,
      );
      const theirs = await beginGeneration(other, 1);
      await advance(other, theirs);
      await cutover(other, theirs);
      assert.equal(
        (await call("search?q=Privateultramarine&tenant=" + other)).json().items
          .length,
        0,
      );
      assert.equal(
        (await call("search?q=checkpoint", "GET", undefined, 2)).json().items
          .length,
        0,
      );
      assert.equal(
        (await call("search?q=Privateultramarine", "GET", undefined, 2)).json()
          .items.length,
        1,
      );
    },
  );
  await t.test(
    "equal and older envelopes cannot resurrect a tombstone",
    async () => {
      const {
        rows: [current],
      } = await source.query(
        "SELECT * FROM documents WHERE tenant=$1 AND id=39",
        [tenant],
      );
      for (const version of [current.version, "1"])
        await project(
          index,
          { tenant, gen: g, mapping: 1 },
          { ...current, version, deleted: false },
        );
      assert.equal(
        (
          await index.query(
            "SELECT deleted FROM projection WHERE tenant=$1 AND gen=$2 AND id=39",
            [tenant, g],
          )
        ).rows[0].deleted,
        true,
      );
    },
  );
  await t.test(
    "a committed sink batch replays after checkpoint loss",
    async () => {
      const before = (await genState(g)).checkpoint;
      await doc(3, "Fenced replay");
      await advance(tenant, g, () => {
        throw Error("injected after sink commit");
      });
      assert.equal((await genState(g)).checkpoint, before);
      assert.equal((await call("search?q=fenced")).json().items.length, 1);
      await source.query(
        "UPDATE generations SET retry_at=now() WHERE tenant=$1 AND gen=$2",
        [tenant, g],
      );
      await advance(tenant, g);
      assert.equal((await genState(g)).error, null);
      assert.equal((await call("search?q=fenced")).json().items.length, 1);
    },
  );
  await t.test(
    "poison blocks acknowledgment then resumes after contract restoration",
    async () => {
      const v = (await doc(5)).json().version;
      await source.query(
        "UPDATE changes SET contract=99 WHERE tenant=$1 AND version=$2",
        [tenant, v],
      );
      await advance(tenant, g);
      assert.equal((await genState(g)).error, "unsupported_change");
      assert.notEqual((await genState(g)).checkpoint, v);
      await source.query(
        "UPDATE changes SET contract=1 WHERE tenant=$1 AND version=$2",
        [tenant, v],
      );
      await source.query(
        "UPDATE generations SET retry_at=now() WHERE tenant=$1 AND gen=$2",
        [tenant, g],
      );
      await advance(tenant, g);
      assert.equal((await genState(g)).checkpoint, v);
    },
  );
  await t.test(
    "shadow mapping switches only at head and invalidates old pagination",
    async () => {
      const next = await beginGeneration(tenant, 2);
      await assert.rejects(beginGeneration(tenant, 1), /already/);
      await advance(tenant, next);
      await doc(42, "Search index checkpoint");
      await advance(tenant, next);
      await assert.rejects(cutover(tenant, next), /reach/);
      assert.equal((await call("search")).json().generation, g);
      await advance(tenant, next);
      await cutover(tenant, next);
      assert.equal(
        (await call("search?gen=" + g + "&offset=2")).statusCode,
        409,
      );
      assert.equal((await genState(g)).phase, "retired");
      const page = (await call("search?limit=2")).json();
      assert.equal(page.next, 2);
      assert.equal(
        (await call("search?offset=2&limit=2")).json().items[0].id,
        3,
      );
      const first = await doc(90, "Calibration");
      assert.equal(first.statusCode, 200);
      await call("documents/91", "PUT", {
        title: "Another entry",
        body: "Calibration",
      });
      await advance(tenant, next);
      assert.deepEqual(
        (await call("search?q=calibration")).json().items.map((r) => r.id),
        [90, 91],
      );
    },
  );
  await t.test(
    "bounded audit detects missing, changed and orphan keys and repairs a page",
    async () => {
      const {
        rows: [{ active }],
      } = await source.query("SELECT active FROM tenants WHERE tenant=$1", [
        tenant,
      ]);
      await transaction(index, async (db) => {
        await db.query(
          "DELETE FROM projection WHERE tenant=$1 AND gen=$2 AND id=1",
          [tenant, active],
        );
        await db.query(
          "UPDATE projection SET title='incorrect' WHERE tenant=$1 AND gen=$2 AND id=2",
          [tenant, active],
        );
        await db.query(
          "INSERT INTO projection VALUES ($1,$2,99,1,'Orphan','',false,2,default)",
          [tenant, active],
        );
      });
      const page = await audit(tenant, 0, false);
      assert.equal(page.checked, 32);
      assert.equal(page.next, 32);
      assert.deepEqual(
        page.differences.map((d) => d.kind),
        ["missing", "different"],
      );
      assert.equal((await audit(tenant, 0, true)).repaired, 2);
      assert.equal((await audit(tenant, 0, false)).differences.length, 0);
      const tail = await audit(tenant, page.next, true);
      assert.deepEqual(tail.differences, [{ id: 99, kind: "orphan" }]);
      assert.equal(
        (await audit(tenant, page.next, false)).differences.length,
        0,
      );
    },
  );
  await t.test(
    "transaction rollback, writer serialization and backlog rejection preserve the feed",
    async () => {
      const id = other;
      const before = (
        await source.query("SELECT head FROM tenants WHERE tenant=$1", [id])
      ).rows[0].head;
      await assert.rejects(
        transaction(source, async (db) => {
          await db.query(
            "UPDATE documents SET title='Never committed' WHERE tenant=$1 AND id=1",
            [id],
          );
          throw new Error("rollback probe");
        }),
        /rollback probe/,
      );
      assert.equal(
        (await source.query("SELECT head FROM tenants WHERE tenant=$1", [id]))
          .rows[0].head,
        before,
      );
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          call(
            "documents/2",
            "PUT",
            { title: "Concurrent " + i, body: "fixture" },
            2,
          ),
        ),
      );
      assert.ok(responses.every((r) => r.statusCode === 200));
      const versions = responses
        .map((r) => BigInt(r.json().version))
        .sort((a, b) => (a < b ? -1 : 1));
      assert.deepEqual(
        versions,
        Array.from({ length: 6 }, (_, i) => BigInt(before) + BigInt(i + 1)),
      );
      // Move only the synthetic tenant clock to the saturation threshold.
      const {
        rows: [state],
      } = await source.query(
        "UPDATE tenants SET head=(SELECT checkpoint FROM generations WHERE tenant=$1 AND gen=1)+10000 WHERE tenant=$1 RETURNING head",
        [id],
      );
      const blocked = await call(
        "documents/3",
        "PUT",
        { title: "Held", body: "fixture" },
        2,
      );
      assert.equal(blocked.statusCode, 503);
      assert.equal(
        (await source.query("SELECT head FROM tenants WHERE tenant=$1", [id]))
          .rows[0].head,
        state.head,
      );
      assert.equal(
        (
          await source.query(
            "SELECT 1 FROM documents WHERE tenant=$1 AND id=3",
            [id],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(audit(tenant, 0, true, 999), /Generation changed/);
    },
  );
});
