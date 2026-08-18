import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { requireAdmin } from '../../middleware/adminMiddleware.js';
import { validate } from '../../middleware/validate.js';
import { deleteRow, listRows, updateRow } from './adminCrud.controller.js';
import {
  AdminListQuerySchema,
  AdminRowParamsSchema,
  AdminTableParamsSchema,
  AdminUpdateSchema
} from './admin.schema.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/:table', validate({ params: AdminTableParamsSchema, query: AdminListQuerySchema }), listRows);
adminRouter.patch('/:table/:id', validate({ params: AdminRowParamsSchema, body: AdminUpdateSchema }), updateRow);
adminRouter.delete('/:table/:id', validate({ params: AdminRowParamsSchema }), deleteRow);
