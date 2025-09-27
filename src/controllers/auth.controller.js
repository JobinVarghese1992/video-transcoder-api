// src/controllers/auth.controller.js
import axios from 'axios';
import qs from 'querystring';
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
    if (result.success === false) {
      return res.status(400).json(result);
    }
    console.log(result, "result from signup");
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
    console.log(result, "result from confirmSignup");
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
    console.log(result, "result from login");
    if (result.success === false) {
      return res.status(400).json(result);
    }
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
    console.log(result, "result from confirmSignin");
    res.json(result);
  } catch (e) {
    next(e);
  }
}

export async function oauthCallback(req, res, next) {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: { code: 'BadRequest', message: 'Missing authorization code' } });
    }

    const data = qs.stringify({
      grant_type: 'authorization_code',
      client_id: process.env.COGNITO_CLIENT_ID,
      client_secret: process.env.COGNITO_CLIENT_SECRET, // required if app client has a secret
      redirect_uri: process.env.COGNITO_REDIRECT_URI,   // must match Cognito App Client config exactly
      code,
    });

    const response = await axios.post(
      `https://${process.env.COGNITO_DOMAIN}/oauth2/token`,
      data,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { id_token, access_token, refresh_token, expires_in, token_type } = response.data;

    return res.json({
      success: true,
      message: 'Federated login successful.',
      data: {
        idToken: id_token,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenType: token_type,
        expiresIn: expires_in,
      },
    });
  } catch (e) {
    console.error('OAuth callback failed:', e.response?.data || e.message);
    return res.status(500).json({ error: { code: 'OAuthError', message: 'Failed to exchange code for tokens' } });
  }
}
