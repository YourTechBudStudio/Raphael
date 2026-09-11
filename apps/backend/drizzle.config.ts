import { defineConfig } from 'drizzle-kit';

/**
 * Authoring-time configuration for `drizzle-kit generate`. The runtime never reads this file: the
 * server applies committed migration assets through Drizzle's migrator, never `push` or runtime
 * generation.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/modules/nodes/schema.ts',
  out: './drizzle',
});
