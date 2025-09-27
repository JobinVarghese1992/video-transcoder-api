// src/routes/index.js
import { Router } from 'express';
import * as AuthController from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.js';
import videosRouter from './videos.routes.js';

export const router = Router();

// Auth (public)
router.post('/auth/signup', AuthController.signup);
router.post('/auth/confirm-signup', AuthController.confirmSignup);

router.post('/auth/login', AuthController.login);
router.post('/auth/confirm-signin', AuthController.confirmSignin);

// OAuth callback
router.get('/auth/oauth/callback', AuthController.oauthCallback);
router.get('/auth/logout', AuthController.logout);
router.get('/logout', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Logged Out</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            text-align: center; 
            margin-top: 100px;
          }
          .box {
            display: inline-block;
            padding: 20px;
            border: 1px solid #ddd;
            border-radius: 8px;
            background: #f9f9f9;
          }
          h1 { color: #333; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>You have been logged out</h1>
          <p><a href="/">Return to Home</a></p>
        </div>
      </body>
    </html>
  `);
});


// Protected routes
router.use(authMiddleware);
router.use('/', videosRouter);

export default router;
