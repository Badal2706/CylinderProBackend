const AuditLog = require('../models/AuditLog');

// Records a verified step-up authorization (Phase 18). Never throws — a failed audit write
// must not roll back the (already-authorized) action itself.
async function record({ userId, action, target = '', detail = '', stepUp }) {
  try {
    await AuditLog.create({
      user_id: userId,
      action,
      target: String(target).slice(0, 200),
      detail: String(detail).slice(0, 500),
      via: stepUp.via,
      person_id: stepUp.person_id || null,
      person_name: stepUp.person_name || ''
    });
  } catch (e) {
    console.error('Audit log write failed:', e.message);
  }
}

async function list(userId, limit = 100) {
  const rows = await AuditLog.find({ user_id: userId }).sort('-createdAt').limit(limit);
  return rows.map(r => ({
    action: r.action,
    target: r.target,
    detail: r.detail,
    via: r.via,
    person_name: r.person_name,
    at: r.createdAt
  }));
}

module.exports = { record, list };
