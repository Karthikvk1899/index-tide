import { source, index } from "./db.js";
import { advance, cutover } from "./engine.js";
import { setTimeout as pause } from "node:timers/promises";
let running = true;
process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});
while (running) {
  try {
    const { rows } = await source.query(
      "SELECT g.tenant,g.gen,t.active FROM generations g JOIN tenants t USING(tenant) WHERE phase<>'retired' AND retry_at<=now() ORDER BY tenant,gen",
    );
    let busy = false;
    for (const g of rows) {
      busy = (await advance(g.tenant, g.gen)) || busy;
      if (g.active === null)
        await cutover(g.tenant, g.gen).catch((e) => {
          if (e.statusCode !== 409) throw e;
        });
    }
    await pause(busy ? 20 : 400);
  } catch (e) {
    console.error(
      JSON.stringify({ event: "worker_unavailable", code: e.code }),
    );
    await pause(1500);
  }
}
await Promise.all([source.end(), index.end()]);
