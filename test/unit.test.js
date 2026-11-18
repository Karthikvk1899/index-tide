import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent } from "../src/engine.js";
const row = {
  tenant: "estuary",
  version: "9007199254740993",
  contract: 1,
  payload: {
    tenant: "estuary",
    id: 10,
    version: "9007199254740993",
    deleted: false,
    title: "Replica",
    body: "Recovery",
  },
};
test("change v1 retains a bigint version without rounding", () =>
  assert.equal(validateEvent(row).version, row.version));
test("rejects incompatible or misrouted payloads", () => {
  for (const change of [
    { contract: 2 },
    { version: "9" },
    { tenant: "upland" },
    { payload: { ...row.payload, id: 0 } },
    { payload: { ...row.payload, deleted: 1 } },
  ])
    assert.throws(
      () => validateEvent({ ...row, ...change }),
      /unsupported_change/,
    );
});
test("published v1 schema and decoder agree on valid and malformed shapes", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: schema } = await import(
    "../src/contracts/change-v1.schema.json",
    { with: { type: "json" } }
  );
  const api = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  api.post("/", { schema: { body: schema } }, async () => ({ ok: true }));
  try {
    for (const [event, ok] of [
      [row, true],
      [{ ...row, contract: 2 }, false],
      [{ ...row, payload: { ...row.payload, title: "" } }, false],
      [{ ...row, payload: { ...row.payload, deleted: 0 } }, false],
    ]) {
      const response = await api.inject({
        method: "POST",
        url: "/",
        payload: event,
      });
      assert.equal(response.statusCode === 200, ok);
      if (ok) assert.deepEqual(validateEvent(event), event.payload);
      else assert.throws(() => validateEvent(event), /unsupported_change/);
    }
  } finally {
    await api.close();
  }
});
