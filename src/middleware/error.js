// src/middleware/error.js
export function notFoundHandler(_req, res) {
    res.status(404).json({ error: { code: 'NotFound', message: 'Route not found' } });
  }
  
  export function errorHandler(err, _req, res, _next) {
    const status = err.statusCode || 500;
    const code =
      err.code ||
      (status === 400
        ? 'BadRequest'
        : status === 401
        ? 'Unauthorized'
        : status === 403
        ? 'Forbidden'
        : status === 404
        ? 'NotFound'
        : status === 409
        ? 'Conflict'
        : 'Internal');
  
    const payload = {
      error: {
        code,
        message: err.message || 'Internal server error',
        details: err.details || undefined
      }
    };
    if (process.env.NODE_ENV === 'development' && err.stack) {
      payload.error.stack = err.stack;
    }
    res.status(status).json(payload);
  }
  