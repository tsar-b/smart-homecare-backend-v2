import { Router } from 'express';
import { initializeCatalog } from './catalog.controller.js';

export const catalogRouter = Router();

catalogRouter.get('/initialize', initializeCatalog);
