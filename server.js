// Load environment variables FIRST, before anything else reads process.env.
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { authLimiter, authSlowDown, apiLimiter } = require('./config/rateLimits');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const connectDB = require('./config/mongodb');
const mongoSanitize = require('./middleware/sanitize');
const logger = require('./logger');

// Fail fast if the JWT secret was not provided via the environment.
if (!process.env.JWT_SECRET) {
  logger.error('FATAL: JWT_SECRET is not set. Add it to your .env file.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

// Trust the reverse proxy (if any) so rate-limit sees the real client IP.
app.set('trust proxy', 1);

// --- Gzip compression (JSON API + any static responses) ---
app.use(compression());

// --- Security headers ---
app.use(helmet());

// --- CORS ---
// In production lock to the app's own frontend origin; in dev allow localhost.
// Set FRONTEND_ORIGIN (comma-separated allowed) in the environment to override.
const allowedOrigins = (process.env.FRONTEND_ORIGIN ||
  'http://localhost:8080,http://localhost:3000,http://127.0.0.1:8080')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / non-browser tools (no Origin header) and any allowed origin.
    // Phase 30: the Cloudflare Pages origin was removed — the app is served only from
    // cylinderpro.guruindustries.co.in (set via FRONTEND_ORIGIN). No pages.dev fallback.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// --- NoSQL injection sanitization (Express 5 safe) ---
app.use(mongoSanitize);

// --- Rate limiting (Phase 30) ---
// Limiters are defined in config/rateLimits.js and are fully env-configurable. They run on an
// in-memory store, correct for the current SINGLE PM2 process. PHASE-30 NOTE: if PM2 is ever moved
// to cluster mode / multiple instances, the in-memory counters become per-process and must be
// backed by a shared store (Redis) — flag before switching.

// Connect to MongoDB
connectDB();

// --- Health check (mounted before rate limiting so monitors aren't throttled) ---
app.get('/api/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1; // 1 = connected
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: connected ? 'connected' : 'disconnected'
  });
});

// Auth routes (unprotected) — strict backoff + failure-cap on EVERY credential/OTP/2FA endpoint.
// Phase 30: cover the previously-unlimited OTP-confirm, 2FA, reset, and email-verify steps too.
// Order matters: slow-down first (adds delay), then the hard failure cap, then the router.
const authRoutes = require('./routes/auth');
const authGuard = [authSlowDown, authLimiter];
app.use('/api/auth/signin', authGuard);            // password login
app.use('/api/auth/signup', authGuard);            // signup OTP gatekeeper
app.use('/api/auth/signup/confirm', authGuard);    // signup OTP verification
app.use('/api/auth/signin/verify-2fa', authGuard); // TOTP / 2FA verification
app.use('/api/auth/forgot-password', authGuard);   // reset request (OTP send)
app.use('/api/auth/forgot-password/reset', authGuard); // reset confirmation
app.use('/api/auth/verify-email', authGuard);      // email-change OTP send + confirm
app.use('/api/auth', authRoutes);

// General API rate limit for everything else.
app.use('/api', apiLimiter);

// Protected routes (each router applies authMiddleware internally)
const customerRoutes = require('./routes/customers');
const billRoutes = require('./routes/bills');
const paymentRoutes = require('./routes/payments');
const reportRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const masterRoutes = require('./routes/masters');
const cylinderRoutes = require('./routes/cylinders');
const profileRoutes = require('./routes/profile');
const rentalChargeRoutes = require('./routes/rentalCharges');
const fillingLogRoutes = require('./routes/fillingLog');
const trustedPeopleRoutes = require('./routes/trustedPeople');
const stepUpRoutes = require('./routes/stepup');

app.use('/api/customers', customerRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/masters', masterRoutes);
app.use('/api/cylinders', cylinderRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/rental-charges', rentalChargeRoutes);
app.use('/api/filling-log', fillingLogRoutes);
app.use('/api/trusted-people', trustedPeopleRoutes);
app.use('/api/step-up', stepUpRoutes);

// Error handling middleware — never leak raw stack/objects to the client.
app.use((err, req, res, next) => {
  logger.error(err.stack || err.message);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  // HttpError (thrown intentionally by a service) carries its own status + safe message.
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  // Mongoose validation/cast failures are caller mistakes, not server faults.
  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.values(err.errors).map((e) => e.message).join('; ');
    return res.status(400).json({ error: details || 'Invalid data submitted.' });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid value for ${err.path || 'a field'}.` });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {}).filter((k) => k !== 'user_id').join(', ');
    return res.status(409).json({ error: field ? `A record with this ${field} already exists.` : 'This record already exists.' });
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});

// --- Graceful shutdown: stop accepting connections, drain in-flight requests, close Mongo ---
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — Server shutting down gracefully`);

  // Stop accepting new connections; callback fires once in-flight requests finish.
  server.close(() => {
    mongoose.connection.close(false)
      .then(() => { logger.info('MongoDB connection closed. Exiting.'); process.exit(0); })
      .catch(() => process.exit(0));
  });

  // Force-exit if requests don't drain within 5 seconds.
  setTimeout(() => {
    logger.error('Could not drain connections in 5s — forcing shutdown.');
    process.exit(1);
  }, 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
