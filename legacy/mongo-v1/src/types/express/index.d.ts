import { IUser } from '../../models/User';
import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}
declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      _id: string;
      userId: string;
      isAdmin: boolean;
      isGuest: boolean;
      provider: 'standard' | 'kakao' | 'apple' | 'guest' ;
      phoneNeedsUpdate?: boolean;
    };
  }
}
