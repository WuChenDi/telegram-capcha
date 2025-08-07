import 'dotenv/config'

import type { Context } from 'telegraf'
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import { createCaptchaSession, verifyCaptcha } from '@/captcha'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '@/db'
import { messageLogs, users, type NewMessageLog, type NewUser } from '@/database/schema'

const bot = new Telegraf(process.env.BOT_TOKEN!)

// Map to store active CAPTCHA sessions
const activeSessions = new Map<number, string>()

// Helper function to get or create user
async function getOrCreateUser(ctx: Context) {
  const telegramUser = ctx.from!

  const existingUsers = await db
    ?.select()
    .from(users)
    .where(eq(users.telegramId, telegramUser.id.toString()))
    .limit(1)

  const existingUser = existingUsers?.[0]

  if (existingUser) {
    return existingUser
  }

  const newUser: NewUser = {
    id: `user_${telegramUser.id}`,
    telegramId: telegramUser.id.toString(),
    username: telegramUser.username || null,
    firstName: telegramUser.first_name || null,
    lastName: telegramUser.last_name || null,
    captchaPassed: false,
    captchaAttempts: 0,
    lastCaptchaAttempt: null,
  }

  await db?.insert(users).values(newUser)

  const createdUsers = await db
    ?.select()
    .from(users)
    .where(eq(users.id, newUser.id))
    .limit(1)

  const createdUser = createdUsers?.[0]

  if (!createdUser) {
    throw new Error('Failed to create user in database')
  }

  return createdUser
}

// Middleware to check if user has passed CAPTCHA
async function requireCaptcha(ctx: Context, next: () => Promise<void>) {
  // Skip for commands and callback queries
  if (
    ctx.updateType === 'callback_query' ||
    (ctx.message && 'text' in ctx.message && ctx.message.text?.startsWith('/'))
  ) {
    return next()
  }

  const user = await getOrCreateUser(ctx)

  if (!user.captchaPassed) {
    // Delete the message
    try {
      await ctx.deleteMessage()
    } catch (e) {
      console.error('Failed to delete message:', e)
    }

    // Log the blocked message
    const messageLog: NewMessageLog = {
      userId: user.id,
      messageText:
        ctx.message && 'text' in ctx.message ? ctx.message.text : '[non-text message]',
      isDeleted: 1,
    }
    await db?.insert(messageLogs).values(messageLog)

    await ctx.reply(
      '⚠️ You need to complete the CAPTCHA before sending messages.\n\nPlease use /start to begin the verification process.'
    )
    return
  }

  return next()
}

// Start command - initiate CAPTCHA
bot.command('start', async (ctx) => {
  const user = await getOrCreateUser(ctx)

  if (user.captchaPassed) {
    return ctx.reply(
      '✅ You have already passed the CAPTCHA. You can send messages freely!'
    )
  }

  // Check rate limiting
  if (user.lastCaptchaAttempt) {
    const timeSinceLastAttempt = Date.now() - user.lastCaptchaAttempt.getTime()

    if (timeSinceLastAttempt < 30000) {
      // 30 seconds cooldown
      const remainingTime = Math.ceil((30000 - timeSinceLastAttempt) / 1000)
      return ctx.reply(
        `⏳ Please wait ${remainingTime} seconds before requesting a new CAPTCHA.`
      )
    }
  }

  // Create CAPTCHA session
  const { sessionId, captchaImage } = await createCaptchaSession(user.id)

  // Store session with Telegram user ID
  activeSessions.set(ctx.from!.id, sessionId)

  // Update last attempt time
  await db
    ?.update(users)
    .set({
      lastCaptchaAttempt: new Date(),
      captchaAttempts: sql`${users.captchaAttempts} + 1`,
    })
    .where(eq(users.id, user.id))

  return ctx.replyWithPhoto(
    { source: captchaImage },
    {
      caption:
        '🔒 Please enter the characters you see in the image to verify you are human.\n\n' +
        'The CAPTCHA will expire in 5 minutes.\n\n' +
        'Type the characters below:',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter CAPTCHA code',
      },
    }
  )
})

// Handle CAPTCHA responses
bot.on(message('text'), async (ctx, next) => {
  const userId = ctx.from!.id

  // Check if user has an active CAPTCHA session
  if (activeSessions.has(userId)) {
    const sessionId = activeSessions.get(userId)!
    const userInput = ctx.message.text

    // Don't process commands as CAPTCHA input
    if (userInput.startsWith('/')) {
      return next()
    }

    const result = await verifyCaptcha(sessionId, userInput)

    if (result.success) {
      activeSessions.delete(userId)

      // Update user's captcha status
      const user = await getOrCreateUser(ctx)

      await db
        ?.update(users)
        .set({
          captchaPassed: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))

      await ctx.reply(
        '✅ CAPTCHA verified successfully! You can now send messages in the group.',
        {
          reply_markup: {
            remove_keyboard: true,
          },
        }
      )
    } else {
      await ctx.reply(
        '❌ ' +
          result.message +
          '\n\nPlease try again or use /start to get a new CAPTCHA.'
      )
    }
    return
  }

  return next()
})

// Apply CAPTCHA requirement to all message types
bot.use(requireCaptcha)

// Handle regular messages (after CAPTCHA check)
bot.on('message', async (ctx) => {
  // Log allowed messages
  const user = await getOrCreateUser(ctx)

  const messageLog: NewMessageLog = {
    userId: user.id,
    messageText: 'text' in ctx.message ? ctx.message.text : '[non-text message]',
    isDeleted: 0,
  }
  await db?.insert(messageLogs).values(messageLog)
})

// Admin commands
bot.command('stats', async (ctx) => {
  // Check if user is admin
  const chatMember = await ctx.getChatMember(ctx.from!.id)
  if (!['creator', 'administrator'].includes(chatMember.status)) {
    return ctx.reply('⛔ This command is only available to administrators.')
  }

  const statsResult = await db
    ?.select({
      totalUsers: sql<number>`COUNT(*)`,
      verifiedUsers: sql<number>`SUM(CASE WHEN captcha_passed = 1 THEN 1 ELSE 0 END)`,
      totalAttempts: sql<number>`SUM(captcha_attempts)`,
    })
    .from(users)
    .where(eq(users.isDeleted, 0))

  const stats = statsResult?.[0]

  const recentBlockedResult = await db
    ?.select({
      blockedMessages: sql<number>`COUNT(*)`,
    })
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.isDeleted, 1),
        sql`${messageLogs.createdAt} > datetime('now', '-1 day')`
      )
    )
  const recentBlocked = recentBlockedResult?.[0]

  return ctx.reply(
    '📊 *Bot Statistics*\n\n' +
      `👥 Total users: ${stats?.totalUsers}\n` +
      `✅ Verified users: ${stats?.verifiedUsers}\n` +
      `🔄 Total CAPTCHA attempts: ${stats?.totalAttempts}\n` +
      `🚫 Messages blocked (24h): ${recentBlocked?.blockedMessages}`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('reset_user', async (ctx) => {
  // Check if user is admin
  const chatMember = await ctx.getChatMember(ctx.from!.id)
  if (!['creator', 'administrator'].includes(chatMember.status)) {
    return ctx.reply('⛔ This command is only available to administrators.')
  }

  // Get user ID from reply or command argument
  let targetUserId: string
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
    targetUserId = ctx.message.reply_to_message.from.id.toString()
  } else {
    const args = ctx.message.text.split(' ')
    if (args.length < 2) {
      return ctx.reply('Usage: /reset_user <user_id> or reply to a user\'s message')
    }
    targetUserId = args[1] || ctx.from!.id.toString()
  }

  await db
    ?.update(users)
    .set({
      captchaPassed: false,
      captchaAttempts: 0,
      lastCaptchaAttempt: null,
    })
    .where(eq(users.telegramId, targetUserId))

  return ctx.reply(
    `🔄 User ${targetUserId} has been reset and will need to complete CAPTCHA again.`
  )
})

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err)
})

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

// Launch bot
bot
  .launch()
  .then(() => console.log('🤖 Bot is running...'))
  .catch((err) => {
    console.error('Failed to start bot:', err)
    process.exit(1)
  })

export default bot
