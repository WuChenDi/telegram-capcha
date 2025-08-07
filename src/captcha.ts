import { createCanvas } from 'canvas'
import crypto from 'node:crypto'
import { eq, and, gt } from 'drizzle-orm'
import { captchaSessions, type NewCaptchaSession } from '@/database/schema'
import { db } from '@/db'

/**
 * Generate random text for CAPTCHA
 * @param length - Length of the text to generate (default: 6)
 * @returns Random string containing uppercase letters and numbers
 */
export function generateRandomText(length: number = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''

  logger.debug('Generating random text for captcha', {
    length,
    action: 'generateRandomText',
  })

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }

  logger.debug('Random text generated successfully', {
    length: result.length,
    action: 'randomTextGenerated',
  })

  return result
}

/**
 * Generate CAPTCHA image with noise and distortion
 * @param text - Text to display in the CAPTCHA
 * @returns PNG image buffer
 */
export function generateCaptchaImage(text: string): Buffer {
  logger.debug('Generating captcha image', {
    textLength: text.length,
    action: 'generateCaptchaImage',
  })

  const width = 200
  const height = 80
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = '#f0f0f0'
  ctx.fillRect(0, 0, width, height)

  // Add noise lines
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = `rgba(${Math.random() * 255},${
      Math.random() * 255
    },${Math.random() * 255},0.3)`
    ctx.beginPath()
    ctx.moveTo(Math.random() * width, Math.random() * height)
    ctx.lineTo(Math.random() * width, Math.random() * height)
    ctx.stroke()
  }

  // Add dots
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = `rgba(${Math.random() * 255},${
      Math.random() * 255
    },${Math.random() * 255},0.5)`
    ctx.fillRect(Math.random() * width, Math.random() * height, 2, 2)
  }

  // Text
  ctx.font = 'bold 40px Arial'
  ctx.fillStyle = '#333'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Add each character with slight rotation
  const charWidth = width / (text.length + 1)
  for (let i = 0; i < text.length; i++) {
    ctx.save()
    const x = charWidth * (i + 1)
    const y = height / 2 + (Math.random() - 0.5) * 10
    ctx.translate(x, y)
    ctx.rotate((Math.random() - 0.5) * 0.4)
    ctx.fillText(text[i]!, 0, 0)
    ctx.restore()
  }

  const buffer = canvas.toBuffer('image/png')

  logger.debug('Captcha image generated successfully', {
    bufferSize: buffer.length,
    imageWidth: width,
    imageHeight: height,
    action: 'captchaImageGenerated',
  })

  return buffer
}

interface CaptchaSessionResult {
  sessionId: string
  captchaImage: Buffer
  captchaText: string
}

/**
 * Create a new CAPTCHA session in database
 * @param userId - ID of the user requesting CAPTCHA
 * @returns Session details including image buffer
 */
export async function createCaptchaSession(
  userId: string
): Promise<CaptchaSessionResult> {
  logger.info('Creating captcha session', {
    userId,
    action: 'createCaptchaSession',
  })

  const captchaText = generateRandomText()
  const sessionId = crypto.randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes

  const newSession: NewCaptchaSession = {
    id: sessionId,
    userId,
    captchaText,
    expiresAt,
    verified: false,
  }

  logger.debug('Inserting captcha session into database', {
    sessionId,
    userId,
    expiresAt: expiresAt.toISOString(),
    action: 'insertCaptchaSession',
  })

  await db?.insert(captchaSessions).values(newSession)

  const captchaImage = generateCaptchaImage(captchaText)

  logger.info('Captcha session created successfully', {
    sessionId,
    userId,
    imageSize: captchaImage.length,
    expiresAt: expiresAt.toISOString(),
    action: 'captchaSessionCreated',
  })

  return {
    sessionId,
    captchaImage,
    captchaText,
  }
}

interface VerifyResult {
  success: boolean
  message: string
}

/**
 * Verify CAPTCHA user input against stored session
 * @param sessionId - ID of the CAPTCHA session
 * @param userInput - User's input to verify
 * @returns Verification result with success status and message
 */
export async function verifyCaptcha(
  sessionId: string,
  userInput: string
): Promise<VerifyResult> {
  logger.info('Verifying captcha', {
    sessionId,
    inputLength: userInput.length,
    action: 'verifyCaptcha',
  })

  const sessions = await db
    ?.select()
    .from(captchaSessions)
    .where(
      and(
        eq(captchaSessions.id, sessionId),
        eq(captchaSessions.verified, false),
        gt(captchaSessions.expiresAt, new Date())
      )
    )
    .limit(1)

  const session = sessions?.[0]

  if (!session) {
    logger.warn('Captcha session not found or expired', {
      sessionId,
      action: 'captchaSessionNotFound',
    })
    return {
      success: false,
      message: 'Invalid or expired CAPTCHA session',
    }
  }

  logger.debug('Captcha session found, comparing input', {
    sessionId,
    userId: session.userId,
    expectedLength: session.captchaText.length,
    inputLength: userInput.length,
    action: 'compareCaptchaInput',
  })

  if (session.captchaText.toUpperCase() === userInput.toUpperCase()) {
    logger.info('Captcha verification successful', {
      sessionId,
      userId: session.userId,
      action: 'captchaVerificationSuccess',
    })

    await db
      ?.update(captchaSessions)
      .set({ verified: true })
      .where(eq(captchaSessions.id, sessionId))

    logger.debug('Captcha session marked as verified', {
      sessionId,
      action: 'captchaSessionVerified',
    })

    return {
      success: true,
      message: 'CAPTCHA verified successfully',
    }
  }

  logger.warn('Captcha verification failed - incorrect input', {
    sessionId,
    userId: session.userId,
    expectedLength: session.captchaText.length,
    inputLength: userInput.length,
    action: 'captchaVerificationFailed',
  })

  return {
    success: false,
    message: 'Incorrect CAPTCHA',
  }
}
