import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import { requireAuth } from '../../../middleware/authMiddleware.js';
import { KakaoLoginSchema } from '../../auth/auth.schema.js';
import {
  deleteKakaoAccount,
  expandKakaoAddress,
  loginKakao,
  searchKakaoAddress
} from './kakao.controller.js';

export const kakaoRouter = Router();

kakaoRouter.post('/login', validate({ body: KakaoLoginSchema }), loginKakao);
kakaoRouter.get('/address', searchKakaoAddress);
kakaoRouter.get('/expand-address', expandKakaoAddress);
kakaoRouter.delete('/delete', requireAuth, deleteKakaoAccount);
kakaoRouter.post('/delete', requireAuth, deleteKakaoAccount);
