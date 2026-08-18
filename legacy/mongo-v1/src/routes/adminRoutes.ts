// src/routes/adminRoutes.ts

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware';
import {getAllBookings, getAdminBookingDetail, filterAdminBookings, deleteBookingById, updateBookingStatus, updateIsAdmin, getAllAdminUsers, deleteUserById} from '../controllers/adminController';


const router = express.Router();

router.use('/', requireAuth, requireAdmin);

// Ensure all routes are protected
router.use(requireAuth, requireAdmin);

// Booking Management
router.get('/bookings', getAllBookings);
router.post('/bookings/filter', filterAdminBookings);
router.patch('/bookings/:id/status', updateBookingStatus);
router.delete('/bookings/:id', deleteBookingById);
router.patch('/users/:id/role', requireAuth, requireAdmin, updateIsAdmin);
router.get('/users', getAllAdminUsers);
router.delete('/users/:id', requireAuth, requireAdmin, deleteUserById);
router.get('/bookings/:id', requireAdmin, getAdminBookingDetail);

export default router;
