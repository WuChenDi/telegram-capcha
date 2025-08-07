import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle as drizzleSqlite } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import * as schema from '@/database/schema'

class DatabaseManager {
  static instance: DatabaseManager
  public db: LibSQLDatabase<typeof schema> | undefined

  constructor() {
    if (DatabaseManager.instance) {
      return DatabaseManager.instance
    }
    DatabaseManager.instance = this

    logger.info('Creating DatabaseManager instance')

    const client = createClient({
      url: process.env.LIBSQL_URL!,
      authToken: process.env.LIBSQL_AUTH_TOKEN!,
    })
    this.db = drizzleSqlite(client, { schema })
  }
}

export const db = new DatabaseManager().db
