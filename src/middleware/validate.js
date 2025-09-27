import { ZodError } from 'zod';

export const validate =
  (schema, from = 'body') =>
    (req, _res, next) => {
      try {
        if (!schema) return next();
        const data = from === 'query' ? req.query : req.body;
        const parsed = schema.parse(data);
        if (from === 'query') req.query = parsed;
        else req.body = parsed;
        next();
      } catch (e) {
        if (e instanceof ZodError) {
          return next({
            statusCode: 400,
            code: 'BadRequest',
            message: 'Invalid request payload',
            details: e.flatten()
          });
        }
        next(e);
      }
    };
