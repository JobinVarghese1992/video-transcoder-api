// src/middleware/auth.js
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getSecret } from '../services/secrets.service';

const idVerifier = CognitoJwtVerifier.create({
  userPoolId: await getSecret("USERPOOL_ID"),
  clientId: await getSecret("CLIENT_ID"),
  tokenUse: "id",
});

function tokenToUser(claims) {
  const username = claims.username || claims['cognito:username'] || claims.sub;
  const groups = claims['cognito:groups'] || [];
  const role = groups.includes('admin') ? 'admin' : 'user';
  return { username, role, groups };
}

export async function authMiddleware(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: { code: 'Unauthorized', message: 'Missing bearer token' } });
  }

  try {
    const claims = await idVerifier.verify(token);
    req.user = tokenToUser(claims);
    return next();
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

export function isAdmin(req) {
  return (req.user?.role || '') === 'admin';
}
