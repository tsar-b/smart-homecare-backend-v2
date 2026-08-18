import { Router } from 'express';
import { login, register, registerGuest } from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import { GuestRegisterSchema, LoginSchema, RegisterSchema } from './auth.schema.js';

export const authRouter = Router();

authRouter.post('/register', validate({ body: RegisterSchema }), register);
authRouter.post('/guest', validate({ body: GuestRegisterSchema }), registerGuest);
authRouter.post('/login', validate({ body: LoginSchema }), login);
