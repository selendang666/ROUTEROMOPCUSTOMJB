import { startServer } from "./bootstrap/bootstrap.js";

startServer().catch((error: unknown) => {
  console.error("[ohmyomop-router] startup failed", error);
  process.exitCode = 1;
});
