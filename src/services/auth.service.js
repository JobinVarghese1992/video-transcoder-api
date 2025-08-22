// src/services/auth.service.js
import { findUser, signToken } from '../middleware/auth.js';

export async function login(username, password) {
  const found = findUser(username, password);
  if (!found) {
    const err = new Error('Invalid username or password');
    err.statusCode = 401;
    err.code = 'Unauthorized';
    throw err;
  }
  const token = signToken({ username: found.username, role: found.role });
  return { token, expiresIn: 3600, role: found.role };
}
