// Centralized application logger (winston).
//  - Always logs to the console.
//  - In production it ALSO writes files: logs/combined.log (all) + logs/error.log (errors only).
//  - Errors include their stack trace.
const fs = require('fs');
const path = require('path');
const winston = require('winston');

const isProd = process.env.NODE_ENV === 'production';
const logDir = process.env.LOG_DIR || path.join(__dirname, 'logs');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Human-readable, colored console output (used in development and in containers).
const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, stack }) => `${timestamp} ${level}: ${stack || message}`)
);

const transports = [new winston.transports.Console({ format: consoleFormat })];

if (isProd) {
  // Ensure the log directory exists before the File transports open their streams.
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  const fileFormat = combine(timestamp(), errors({ stack: true }), json());
  transports.push(new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error', format: fileFormat }));
  transports.push(new winston.transports.File({ filename: path.join(logDir, 'combined.log'), format: fileFormat }));
}

const logger = winston.createLogger({
  level: isProd ? 'info' : 'debug',
  transports,
  exitOnError: false
});

module.exports = logger;
