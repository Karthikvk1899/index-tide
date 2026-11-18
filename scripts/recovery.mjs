import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
const compose = (...args) =>
  execFileSync("docker", ["compose", ...args], { stdio: "inherit" });
const base = "http://127.0.0.1:8080/api/v1/";
const headers = {
  Authorization: "Bearer " + process.env.UPLAND_KEY,
  "Content-Type": "application/json",
};
const req = (path, options = {}) => fetch(base + path, { headers, ...options });
async function until(check, label) {
  for (let i = 0; i < 90; i++) {
    try {
      if (await check()) return;
    } catch {}
    await pause(500);
  }
  throw Error("Timed out: " + label);
}
const status = async () => (await (await req("status")).json()).generations[0];
await until(async () => (await status()).active, "initial cutover");
compose("stop", "search");
try {
  const r = await req("documents/1001", {
    method: "PUT",
    body: JSON.stringify({
      title: "Indigo outage sentinel",
      body: "Generated recovery fixture",
    }),
  });
  assert.equal(r.status, 200);
  const { version } = await r.json();
  await until(async () => {
    const g = await status();
    return (
      g.error === "index_batch_failed" && BigInt(g.checkpoint) < BigInt(version)
    );
  }, "persisted index outage");
  assert.equal((await req("search?q=indigo")).status, 503);
  compose("kill", "-s", "SIGKILL", "worker");
  compose("start", "search");
  compose("start", "worker");
  await until(async () => {
    const g = await status();
    return (
      g.checkpoint === version &&
      !g.error &&
      (await (await req("search?q=indigo")).json()).items.length === 1
    );
  }, "worker restart and search recovery");
  assert.equal(
    (
      await req("documents/1001", {
        method: "DELETE",
        headers: { Authorization: headers.Authorization },
      })
    ).status,
    200,
  );
  await until(
    async () =>
      (await (await req("search?q=indigo")).json()).items.length === 0,
    "delete propagation",
  );
} finally {
  compose("start", "search", "worker");
}
