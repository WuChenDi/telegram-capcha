import 'dotenv/config'

import '@/global'
import { Telegraf, type Context } from 'telegraf'
import { message } from 'telegraf/filters'
import { eq, and, sql } from 'drizzle-orm'
import { createCaptchaSession, verifyCaptcha } from '@/captcha'
import { messageLogs, users, type NewMessageLog, type NewUser } from '@/database/schema'
import { db } from '@/db'

const bot = new Telegraf(process.env.BOT_TOKEN!)

// Map to store active CAPTCHA sessions
const activeSessions = new Map<number, string>()

// Helper function to get or create user
async function getOrCreateUser(ctx: Context) {
  const telegramUser = ctx.from!

  logger.debug('Getting or creating user', {
    telegramId: telegramUser.id,
    username: telegramUser.username,
    action: 'getOrCreateUser',
  })

  const existingUsers = await db
    ?.select()
    .from(users)
    .where(eq(users.telegramId, telegramUser.id.toString()))
    .limit(1)

  const existingUser = existingUsers?.[0]

  if (existingUser) {
    logger.debug('Found existing user', {
      userId: existingUser.id,
      telegramId: existingUser.telegramId,
      captchaPassed: existingUser.captchaPassed,
      action: 'userFound',
    })
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

  logger.info('Creating new user', {
    userId: newUser.id,
    telegramId: newUser.telegramId,
    username: newUser.username,
    action: 'createUser',
  })

  await db?.insert(users).values(newUser)

  const createdUsers = await db
    ?.select()
    .from(users)
    .where(eq(users.id, newUser.id))
    .limit(1)

  const createdUser = createdUsers?.[0]

  if (!createdUser) {
    logger.error('Failed to create user in database', {
      userId: newUser.id,
      telegramId: newUser.telegramId,
      action: 'createUserFailed',
    })
    throw new Error('Failed to create user in database')
  }

  logger.info('User created successfully', {
    userId: createdUser.id,
    telegramId: createdUser.telegramId,
    action: 'userCreated',
  })

  return createdUser
}

// Middleware to check if user has passed CAPTCHA
async function requireCaptcha(ctx: Context, next: () => Promise<void>) {
  // Skip for commands and callback queries
  if (
    ctx.updateType === 'callback_query' ||
    (ctx.message && 'text' in ctx.message && ctx.message.text?.startsWith('/'))
  ) {
    logger.debug('Skipping captcha check', {
      updateType: ctx.updateType,
      userId: ctx.from?.id,
      action: 'skipCaptchaCheck',
    })
    return next()
  }

  const user = await getOrCreateUser(ctx)

  if (!user.captchaPassed) {
    logger.warn('User has not passed captcha, blocking message', {
      userId: user.id,
      telegramId: user.telegramId,
      username: user.username,
      action: 'blockMessage',
    })

    // Delete the message
    try {
      await ctx.deleteMessage()
      logger.debug('Message deleted successfully', {
        userId: user.id,
        action: 'messageDeleted',
      })
    } catch (e) {
      logger.error('Failed to delete message', {
        userId: user.id,
        error: e instanceof Error ? e.message : 'Unknown error',
        action: 'deleteMessageError',
      })
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

    logger.info('Blocked message logged to database', {
      userId: user.id,
      messageLength: messageLog.messageText?.length || 0,
      action: 'logBlockedMessage',
    })

    await ctx.reply(
      '⚠️ You need to complete the CAPTCHA before sending messages.\n\nPlease use /start to begin the verification process.'
    )
    return
  }

  logger.debug('User passed captcha check', {
    userId: user.id,
    action: 'captchaCheckPassed',
  })

  return next()
}

// Start command - initiate CAPTCHA
bot.command('start', async (ctx) => {
  logger.info('Start command received', {
    userId: ctx.from?.id,
    username: ctx.from?.username,
    chatId: ctx.chat?.id,
    action: 'startCommand',
  })

  const user = await getOrCreateUser(ctx)

  if (user.captchaPassed) {
    logger.info('User already passed captcha', {
      userId: user.id,
      action: 'alreadyPassed',
    })
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

      logger.warn('User hit rate limit for captcha', {
        userId: user.id,
        timeSinceLastAttempt,
        remainingTime,
        action: 'rateLimited',
      })

      return ctx.reply(
        `⏳ Please wait ${remainingTime} seconds before requesting a new CAPTCHA.`
      )
    }
  }

  // Create CAPTCHA session
  const { sessionId, captchaImage } = await createCaptchaSession(user.id)

  // Store session with Telegram user ID
  activeSessions.set(ctx.from!.id, sessionId)

  logger.info('CAPTCHA session created', {
    userId: user.id,
    sessionId,
    telegramUserId: ctx.from!.id,
    captchaAttempts: user.captchaAttempts + 1,
    action: 'captchaCreated',
  })

  // Update last attempt time
  await db
    ?.update(users)
    .set({
      lastCaptchaAttempt: new Date(),
      captchaAttempts: sql`${users.captchaAttempts} + 1`,
    })
    .where(eq(users.id, user.id))

  logger.debug('User captcha attempt counter updated', {
    userId: user.id,
    action: 'attemptCountUpdated',
  })

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

    logger.debug('CAPTCHA response received', {
      userId,
      sessionId,
      inputLength: userInput.length,
      isCommand: userInput.startsWith('/'),
      action: 'captchaResponse',
    })

    // Don't process commands as CAPTCHA input
    if (userInput.startsWith('/')) {
      logger.debug('Skipping command as captcha input', {
        userId,
        command: userInput,
        action: 'skipCommandAsCaptcha',
      })
      return next()
    }

    const result = await verifyCaptcha(sessionId, userInput)

    if (result.success) {
      activeSessions.delete(userId)

      logger.info('CAPTCHA verification successful', {
        userId,
        sessionId,
        action: 'captchaSuccess',
      })

      // Update user's captcha status
      const user = await getOrCreateUser(ctx)

      await db
        ?.update(users)
        .set({
          captchaPassed: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))

      logger.info('User captcha status updated to passed', {
        userId: user.id,
        telegramId: user.telegramId,
        action: 'captchaPassed',
      })

      await ctx.reply(
        '✅ CAPTCHA verified successfully! You can now send messages in the group.',
        {
          reply_markup: {
            remove_keyboard: true,
          },
        }
      )
    } else {
      logger.warn('CAPTCHA verification failed', {
        userId,
        sessionId,
        reason: result.message,
        inputLength: userInput.length,
        action: 'captchaFailed',
      })

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

  logger.info('Message allowed and logged', {
    userId: user.id,
    messageLog,
    messageLength: messageLog.messageText?.length || 0,
    action: 'messageAllowed',
  })
})

// Admin commands
bot.command('stats', async (ctx) => {
  logger.info('Stats command received', {
    userId: ctx.from?.id,
    username: ctx.from?.username,
    chatId: ctx.chat?.id,
    action: 'statsCommand',
  })

  // Check if user is admin
  const chatMember = await ctx.getChatMember(ctx.from!.id)
  if (!['creator', 'administrator'].includes(chatMember.status)) {
    logger.warn('Non-admin attempted stats command', {
      userId: ctx.from?.id,
      userStatus: chatMember.status,
      action: 'statsUnauthorized',
    })
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

  logger.info('Stats retrieved successfully', {
    totalUsers: stats?.totalUsers,
    verifiedUsers: stats?.verifiedUsers,
    totalAttempts: stats?.totalAttempts,
    blockedMessages24h: recentBlocked?.blockedMessages,
    adminId: ctx.from?.id,
    action: 'statsRetrieved',
  })

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
  logger.info('Reset user command received', {
    adminId: ctx.from?.id,
    chatId: ctx.chat?.id,
    action: 'resetUserCommand',
  })

  // Check if user is admin
  const chatMember = await ctx.getChatMember(ctx.from!.id)
  if (!['creator', 'administrator'].includes(chatMember.status)) {
    logger.warn('Non-admin attempted reset user command', {
      userId: ctx.from?.id,
      userStatus: chatMember.status,
      action: 'resetUserUnauthorized',
    })
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

  logger.info('Resetting user captcha status', {
    targetUserId,
    adminId: ctx.from?.id,
    action: 'resetUserExecute',
  })

  await db
    ?.update(users)
    .set({
      captchaPassed: false,
      captchaAttempts: 0,
      lastCaptchaAttempt: null,
    })
    .where(eq(users.telegramId, targetUserId))

  // Remove from active sessions if exists
  const telegramUserId = Number.parseInt(targetUserId)
  if (activeSessions.has(telegramUserId)) {
    activeSessions.delete(telegramUserId)
    logger.debug('Removed user from active sessions', {
      targetUserId,
      action: 'removeActiveSession',
    })
  }

  logger.info('User reset successfully', {
    targetUserId,
    adminId: ctx.from?.id,
    action: 'resetUserSuccess',
  })

  return ctx.reply(
    `🔄 User ${targetUserId} has been reset and will need to complete CAPTCHA again.`
  )
})

// Error handling
bot.catch((err, ctx) => {
  logger.error('Bot error caught', {
    error:
      err instanceof Error
        ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          }
        : err,
    updateType: ctx.updateType,
    userId: ctx.from?.id,
    chatId: ctx.chat?.id,
    action: 'botError',
  })
  console.error(`Error for ${ctx.updateType}:`, err)
})

// Graceful shutdown
process.once('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully', {
    action: 'shutdown',
    signal: 'SIGINT',
  })
  bot.stop('SIGINT')
})

process.once('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully', {
    action: 'shutdown',
    signal: 'SIGTERM',
  })
  bot.stop('SIGTERM')
})

// Launch bot
bot
  .launch()
  .then(() => {
    logger.info('🤖 Bot is running...', {
      action: 'botLaunched',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'unknown',
    })
  })
  .catch((err) => {
    logger.error('Failed to start bot', {
      error:
        err instanceof Error
          ? {
              name: err.name,
              message: err.message,
              stack: err.stack,
            }
          : err,
      action: 'botStartupError',
    })
    process.exit(1)
  })

export default bot
