import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { deleteMe, getMe, updateMe } from './user.controller.js';

export const userRouter = Router();

userRouter.get('/me', requireAuth, getMe);
userRouter.patch('/me', requireAuth, updateMe);
userRouter.delete('/me', requireAuth, deleteMe);
