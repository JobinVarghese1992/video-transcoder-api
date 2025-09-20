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

// Protected routes
router.use(authMiddleware);
router.use('/', videosRouter);

export default router;
