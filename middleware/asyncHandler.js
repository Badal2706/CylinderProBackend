// Wraps an async controller function so any thrown/rejected error is forwarded to
// Express's error-handling middleware via next(err), instead of needing a try/catch
// in every controller method.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
