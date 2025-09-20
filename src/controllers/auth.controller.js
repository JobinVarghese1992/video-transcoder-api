// src/controllers/auth.controller.js
import * as AuthService from '../services/auth.service.js';

export async function signup(req, res, next) {
  try {
    const { username, password, email } = req.body || {};
    if (!username || !password || !email) {
      return res
        .status(400)
        .json({ error: { code: 'BadRequest', message: 'username, password and email are required' } });
    }
    const result = await AuthService.signup(username, password, email);
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
}

export async function confirmSignup(req, res, next) {
  try {
    const { username, confirmationCode } = req.body || {};
    if (!username || !confirmationCode) {
      return res
        .status(400)
        .json({ error: { code: 'BadRequest', message: 'username and confirmation code are required' } });
    }
    const result = await AuthService.confirmSignup(username, confirmationCode);
    res.json(result);
  } catch (e) {
    next(e);
  }
}

export async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: { code: 'BadRequest', message: 'username and password are required' } });
    }
    const result = await AuthService.login(username, password);

    res.json(result);
  } catch (e) {
    next(e);
  }
}

export async function confirmSignin(req, res, next) {
  try {
    const { username, confirmationCode, session } = req.body || {};
    if (!username || !confirmationCode || !session) {
      return res
        .status(400)
        .json({ error: { code: 'BadRequest', message: 'username, confirmationCode and session are required' } });
    }
    const result = await AuthService.confirmSignin(username, confirmationCode, session);
    res.json(result);
  } catch (e) {
    next(e);
  }
}
