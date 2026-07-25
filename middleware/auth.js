const jwt = require('jsonwebtoken');
const User = require('../models/User');
if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set. Set it before starting the server.');
}
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }
  let payload;
  try {
    payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'TOKEN_EXPIRED' });
  }
  try {
    // Validate the token against the user's current token_version (supports "log out all").
    const user = await User.findById(payload.id).select('token_version sessions');
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.', code: 'NO_USER' });
    }
    if ((payload.tv || 0) !== (user.token_version || 0)) {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'TOKEN_REVOKED' });
    }
    // Per-device sessions (Phase 17): a token bound to a session (sid) is only valid while
    // that session is still on the user's list — revoking a device removes it immediately.
    // Legacy tokens without a sid stay valid until their own (24h) expiry.
    if (payload.sid) {
      const sess = (user.sessions || []).find(s => s.sid === payload.sid);
      if (!sess || sess.expires_at <= new Date()) {
        return res.status(401).json({ error: 'This device\'s session was revoked or expired. Please log in again.', code: 'TOKEN_REVOKED' });
      }
      // Keep last_active fresh (throttled to once a minute; fire-and-forget).
      if (Date.now() - new Date(sess.last_active).getTime() > 60 * 1000) {
        User.updateOne(
          { _id: user._id, 'sessions.sid': payload.sid },
          { $set: { 'sessions.$.last_active': new Date() } }
        ).catch(() => {});
      }
    }
    req.user = payload;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authentication check failed.' });
  }
};
