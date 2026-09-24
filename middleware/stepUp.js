const { requireStepUp } = require('../services/stepup.service');

// Phase 18 gate middleware. Reads the step-up token from the x-step-up-token header (or
// step_up_token in the body) and attaches the verified payload as req.stepUp.
// Responds 403 (never 401 — that would trip the frontend's session-expiry logout).

// For authenticated routes: token must belong to the logged-in user.
// `label` opens the message. It defaults to "Saving this change" because every gated route was a
// save until GEN-C added the first read-only one (the full cylinder history), where that wording
// would tell the operator they were about to change something they were only trying to read.
function stepUpGate(label) {
  return function (req, res, next) {
    try {
      req.stepUp = requireStepUp(req.user.id, req.headers['x-step-up-token'] || (req.body && req.body.step_up_token), label);
      next();
    } catch (e) {
      res.status(e.status || 403).json({ error: e.message, code: 'STEP_UP_REQUIRED' });
    }
  };
}

const requireStepUpAuth = stepUpGate('Saving this change');

module.exports = { requireStepUpAuth, stepUpGate };
