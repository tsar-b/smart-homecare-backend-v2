// src/routes/apiRoutes.ts

import express from 'express';
import { registerUser, getUserBookingDetail, updateUser, createBooking, getOptions, getPricing, getCurrentUser, loginUser, deleteUser, getAllServiceTypes, getAvailableTimeSlots, getUserBookingHistory} from '../controllers/apiController';
import { kakaoLogin, deleteKakaoAccount, searchKakaoAddress, searchExpandedRoad, loginApple } from '../controllers/oAuthController';
import { requireAuth } from '../middleware/authMiddleware';
import { getBookingInitializeData } from '../controllers/bookingController';

const router = express.Router();

router.post('/register', registerUser);
router.post('/kakao/login', kakaoLogin);
router.get('/kakao/address', searchKakaoAddress);
router.post('/auth/apple', loginApple);
router.post('/login', loginUser);
router.get('/options', getOptions);       
router.get('/pricing', getPricing);
router.post('/booking', requireAuth, createBooking);
router.get('/timeslots', getAvailableTimeSlots);
router.get('/users/me', requireAuth, getCurrentUser);
router.get('/booking/initialize', getBookingInitializeData);
router.delete('/users/me', requireAuth, deleteUser);
router.get('/servicetypes', getAllServiceTypes);
router.get('/history', requireAuth, getUserBookingHistory);
router.patch('/users/me', requireAuth, updateUser);
router.get('/kakao/expand-address', searchExpandedRoad);
router.delete('/kakao/delete', requireAuth, deleteKakaoAccount);
router.post('/kakao/delete', requireAuth, deleteKakaoAccount);
router.get('/historydetail/:id', requireAuth, getUserBookingDetail);
export default router;
