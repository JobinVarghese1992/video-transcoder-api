// src/controllers/auth.controller.js
import * as AuthService from '../services/auth.service.js';

export async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: { code: 'BadRequest', message: 'username and password are required' } });
    }
    const { token, expiresIn, role } = await AuthService.login(username, password);
    res.json({ token, expiresIn, role });
  } catch (e) {
    next(e);
  }
}
