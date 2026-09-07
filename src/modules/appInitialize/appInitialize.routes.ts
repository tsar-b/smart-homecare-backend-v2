import { Router } from 'express';
import { initializeApp } from './appInitialize.controller.js';

export const appInitializeRouter = Router();

appInitializeRouter.get('/initialize', initializeApp);
