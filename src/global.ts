import * as winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'

const isDebug = process.env.NODE_ENV === 'dev'

declare global {
  var logger: winston.Logger
  var isDebug: boolean
}

// logger
const logger = winston.createLogger({
  level: isDebug ? 'debug' : 'info',
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level}]: ${message}`
        })
      ),
    }),
    new DailyRotateFile({
      filename: 'logs/bc-gambling-table-%DATE%.log',
      datePattern: 'YYYY-MM-DD-HH',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
  ],
})

globalThis.logger = logger
globalThis.isDebug = isDebug
