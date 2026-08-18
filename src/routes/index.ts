import type { Express } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { userRouter } from '../modules/users/user.routes.js';
import { adminRouter } from '../modules/adminCrud/admin.routes.js';
import { bookingRouter } from '../modules/bookings/booking.routes.js';
import { catalogRouter } from '../modules/catalog/catalog.routes.js';
import { kakaoRouter } from '../modules/integrations/kakao/kakao.routes.js';
import { appInitializeRouter } from '../modules/appInitialize/appInitialize.routes.js';
import { requestRouter } from '../modules/requests/request.routes.js';

export function registerRoutes(app: Express) {
  app.use('/api/app', appInitializeRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/bookings', bookingRouter);
  app.use('/api/requests', requestRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/kakao', kakaoRouter);
}
