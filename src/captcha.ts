import { createCanvas } from 'canvas'
import crypto from 'node:crypto'
import { eq, and, gt } from 'drizzle-orm'
import { captchaSessions, type NewCaptchaSession } from '@/database/schema'
import { db } from '@/db'

export function generateRandomText(length: number = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export function generateCaptchaImage(text: string): Buffer {
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

  return canvas.toBuffer('image/png')
}

interface CaptchaSessionResult {
  sessionId: string
  captchaImage: Buffer
  captchaText: string
}

export async function createCaptchaSession(
  userId: string
): Promise<CaptchaSessionResult> {
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

  await db?.insert(captchaSessions).values(newSession)

  const captchaImage = generateCaptchaImage(captchaText)

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

export async function verifyCaptcha(
  sessionId: string,
  userInput: string
): Promise<VerifyResult> {
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
    return { success: false, message: 'Invalid or expired CAPTCHA session' }
  }

  if (session.captchaText.toUpperCase() === userInput.toUpperCase()) {
    await db
      ?.update(captchaSessions)
      .set({ verified: true })
      .where(eq(captchaSessions.id, sessionId))

    return { success: true, message: 'CAPTCHA verified successfully' }
  }

  return { success: false, message: 'Incorrect CAPTCHA' }
}
