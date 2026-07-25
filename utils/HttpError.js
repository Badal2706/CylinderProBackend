// Thrown by services to signal an intentional HTTP-mapped error (validation, 404, etc).
// Caught centrally in server.js's error middleware, which uses `status`/`message` verbatim.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = HttpError;
