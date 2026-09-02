import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { deleteMe, getMe, updateMe } from './user.controller.js';
import { validate } from '../../middleware/validate.js';
import { UpdateProfileSchema } from './user.schema.js';

export const userRouter = Router();

userRouter.get('/me', requireAuth, getMe);
userRouter.patch('/me', requireAuth, validate({ body: UpdateProfileSchema }), updateMe);
userRouter.delete('/me', requireAuth, deleteMe);
