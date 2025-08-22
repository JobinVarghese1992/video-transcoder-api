// src/middleware/auth.js
import jwt from 'jsonwebtoken';

const users = [
  { username: 'admin@example.com', password: 'Admin@123', role: 'admin' },
  { username: 'user1@example.com', password: 'User1@123', role: 'user' },
  { username: 'user2@example.com', password: 'User2@123', role: 'user' }
];

export function findUser(username, password) {
  return users.find((u) => u.username === username && u.password === password);
}

export function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  const token = jwt.sign(payload, secret, { expiresIn: 3600 });
  return token;
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: 'Unauthorized', message: 'Missing bearer token' } });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { username: decoded.username, role: decoded.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: { code: 'Unauthorized', message: 'Invalid or expired token' } });
  }
}

export function requireAdminOrOwner(owner) {
  return (req, res, next) => {
    const { role, username } = req.user || {};
    if (role === 'admin' || username === owner) return next();
    return res.status(403).json({ error: { code: 'Forbidden', message: 'Requires admin or owner' } });
  };
}
