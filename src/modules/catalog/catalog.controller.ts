import type { Request, Response } from 'express';
import { initializeApp } from '../appInitialize/appInitialize.controller.js';

export async function initializeCatalog(req: Request, res: Response) {
  await initializeApp(req, res);
}
