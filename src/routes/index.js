// src/routes/index.js
import { Router } from 'express';
import * as AuthController from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.js';
import videosRouter from './videos.routes.js';

export const router = Router();

// Auth (public)
router.post('/auth/login', AuthController.login);

// Protected routes
router.use(authMiddleware);

router.use('/', videosRouter);
