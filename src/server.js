import { app } from "./api.js";
import { source, index } from "./db.js";
const server = app([
  { tenant: "estuary", role: "operator", token: process.env.OPERATOR_KEY },
  { tenant: "estuary", role: "reader", token: process.env.READER_KEY },
  { tenant: "upland", role: "operator", token: process.env.UPLAND_KEY },
]);
await server.listen({
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8080),
});
process.on("SIGTERM", async () => {
  await server.close();
  await Promise.all([source.end(), index.end()]);
});
