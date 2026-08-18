import { Router } from 'express';
import { searchKakaoAddress } from './kakao.controller.js';

export const kakaoRouter = Router();

kakaoRouter.get('/address', searchKakaoAddress);
