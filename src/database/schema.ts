import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

const trackingFields = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
  isDeleted: integer('is_deleted').notNull().default(0),
}

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  telegramId: text('telegram_id').notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  captchaPassed: integer('captcha_passed', { mode: 'boolean' }).default(false).notNull(),
  captchaAttempts: integer('captcha_attempts').default(0).notNull(),
  lastCaptchaAttempt: integer('last_captcha_attempt', { mode: 'timestamp' }),
  ...trackingFields,
})

export const captchaSessions = sqliteTable('captcha_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  captchaText: text('captcha_text').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  verified: integer('verified', { mode: 'boolean' }).default(false).notNull(),
  ...trackingFields,
})

export const messageLogs = sqliteTable('message_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  messageText: text('message_text'),
  ...trackingFields,
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type CaptchaSession = typeof captchaSessions.$inferSelect
export type NewCaptchaSession = typeof captchaSessions.$inferInsert
export type MessageLog = typeof messageLogs.$inferSelect
export type NewMessageLog = typeof messageLogs.$inferInsert
