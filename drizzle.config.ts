import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config for PostgreSQL control-plane.
 * Uses single-source schema from src/persistence/schema/pg.ts.
 * Output in drizzle/pg is the runtime migration source loaded by
 * src/persistence/migrate.ts via readMigrationFiles() + advisory lock.
 * Regenerate with: bunx drizzle-kit generate
 */
export default defineConfig({
  schema: "./src/persistence/schema/pg.ts",
  out: "./drizzle/pg",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router",
  },
  verbose: true,
  strict: true,
});
