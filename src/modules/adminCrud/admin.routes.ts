import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { requireAdmin } from '../../middleware/adminMiddleware.js';
import { validate } from '../../middleware/validate.js';
import {
  deleteAdminBooking,
  deleteAdminUser,
  deleteRow,
  createRow,
  filterAdminBookings,
  getAdminBooking,
  listAdminBookings,
  listAdminUsers,
  listRows,
  updateAdminBooking,
  updateAdminRole,
  updateRow
} from './adminCrud.controller.js';
import {
  AdminBookingFilterSchema,
  AdminBookingUpdateSchema,
  AdminListQuerySchema,
  AdminRoleUpdateSchema,
  AdminRowParamsSchema,
  AdminTableParamsSchema,
  AdminUpdateSchema
} from './admin.schema.js';
import {
  deleteAdminBookingAttachment,
  getAdminAttachmentDownloadUrl,
  listAdminBookingAttachments
} from '../bookingAttachments/bookingAttachment.controller.js';
import {
  BookingAttachmentBookingParamsSchema,
  BookingAttachmentParamsSchema
} from '../bookingAttachments/bookingAttachment.schema.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/bookings', listAdminBookings);
adminRouter.post('/bookings/filter', validate({ body: AdminBookingFilterSchema }), filterAdminBookings);
adminRouter.get(
  '/bookings/:bookingId/attachments',
  validate({ params: BookingAttachmentBookingParamsSchema }),
  listAdminBookingAttachments
);
adminRouter.get(
  '/bookings/:bookingId/attachments/:attachmentId/download-url',
  validate({ params: BookingAttachmentParamsSchema }),
  getAdminAttachmentDownloadUrl
);
adminRouter.delete(
  '/bookings/:bookingId/attachments/:attachmentId',
  validate({ params: BookingAttachmentParamsSchema }),
  deleteAdminBookingAttachment
);
adminRouter.patch(
  '/bookings/:id/status',
  validate({ params: AdminRowParamsSchema.omit({ table: true }), body: AdminBookingUpdateSchema }),
  updateAdminBooking
);
adminRouter.get('/bookings/:id', validate({ params: AdminRowParamsSchema.omit({ table: true }) }), getAdminBooking);
adminRouter.delete('/bookings/:id', validate({ params: AdminRowParamsSchema.omit({ table: true }) }), deleteAdminBooking);

adminRouter.get('/users', listAdminUsers);
adminRouter.patch(
  '/users/:id/role',
  validate({ params: AdminRowParamsSchema.omit({ table: true }), body: AdminRoleUpdateSchema }),
  updateAdminRole
);
adminRouter.delete('/users/:id', validate({ params: AdminRowParamsSchema.omit({ table: true }) }), deleteAdminUser);

adminRouter.get('/data/:table', validate({ params: AdminTableParamsSchema, query: AdminListQuerySchema }), listRows);
adminRouter.post('/data/:table', validate({ params: AdminTableParamsSchema, body: AdminUpdateSchema }), createRow);
adminRouter.patch('/data/:table/:id', validate({ params: AdminRowParamsSchema, body: AdminUpdateSchema }), updateRow);
adminRouter.delete('/data/:table/:id', validate({ params: AdminRowParamsSchema }), deleteRow);
