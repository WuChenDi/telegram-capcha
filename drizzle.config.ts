import type { Config } from 'drizzle-kit'

export default {
  schema: './src/database/schema.ts',
  out: './src/database',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.LIBSQL_URL!,
    authToken: process.env.LIBSQL_AUTH_TOKEN!,
  },
} satisfies Config
