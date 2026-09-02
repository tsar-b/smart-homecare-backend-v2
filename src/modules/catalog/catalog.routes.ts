import { Router } from 'express';
import { getOptions, getPricing, getServiceTypes, initializeCatalog } from './catalog.controller.js';

export const catalogRouter = Router();

catalogRouter.get('/initialize', initializeCatalog);
catalogRouter.get('/service-types', getServiceTypes);
catalogRouter.get('/options', getOptions);
catalogRouter.get('/pricing', getPricing);

export const legacyCatalogRouter = Router();
legacyCatalogRouter.get('/booking/initialize', initializeCatalog);
legacyCatalogRouter.get('/servicetypes', getServiceTypes);
legacyCatalogRouter.get('/options', getOptions);
legacyCatalogRouter.get('/pricing', getPricing);
