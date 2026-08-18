// src/adminController.ts

import { Request, Response } from 'express';
import Booking from '../models/bookingModel';
import User from '../models/User';

// GET /api/admin/bookings
export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await Booking.find().sort({ reservationDate: -1 });

    const users = await User.find({}, 'userId address phone'); // only pull fields that are necessary

    const enriched = bookings.map((booking) => {
    const user = users.find((u) => u.userId === booking.user);
    const fullAddress = user
    ? `${(user.address ?? '').trim()} ${(user.addressDetail ?? '').trim()}`.trim()
    : null;

  return {
    ...booking.toObject(),
    userAddress: fullAddress,
    userPhone: user?.phone ?? null,
  };
});
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '전체 예약 조회 실패' });
  }
};

// POST /api/admin/bookings/filter
export const filterAdminBookings = async (req: Request, res: Response) => {
  try {
    const start = req.body.start ?? req.body.startDate;
    const end = req.body.end ?? req.body.endDate;

    if (!start || !end) {
      res.status(400).json({ message: 'start / end date required' });
      return;
    }

    const bookings = await Booking.find({
      reservationDate: { $gte: start, $lte: end },
    }).sort({ reservationDate: -1 });

    const users = await User.find({}, 'userId address addressDetail phone');

    const enriched = bookings.map((booking) => {
    const user = users.find((u) => u.userId === booking.user);

    const fullAddress = user
    ? `${(user.address ?? '').trim()} ${(user.addressDetail ?? '').trim()}`.trim()
    : null;

    return {
      ...booking.toObject(),
      userAddress: fullAddress,
      userPhone: user?.phone ?? null,
    };
  });

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};


// PATCH /api/admin/bookings/:id/status
export const updateBookingStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, totalPrice, options } = req.body;

    const updatePayload: Partial<{
      status: '대기' | '확정' | '완료' | '취소';
      totalPrice: number;
      options: { option: string; choice: string }[];
    }> = {};

    if (status) updatePayload.status = status;
    if (typeof totalPrice === 'number') updatePayload.totalPrice = totalPrice;
    if (Array.isArray(options)) updatePayload.options = options;

    const updated = await Booking.findByIdAndUpdate(id, updatePayload, {
      new: true,
    });

    if (!updated) {
      res.status(404).json({ message: '예약을 찾을 수 없습니다.' });
      return;
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '상태/가격/옵션 업데이트 실패' });
  }
};

// DELETE /api/admin/bookings/:id
export const deleteBookingById = async (req: Request, res: Response): Promise<void> => {
    try {
      const deleted = await Booking.findByIdAndDelete(req.params.id);
      if (!deleted) {
        res.status(404).json({ message: '예약이 존재하지 않습니다.' });
        return;
      }
      res.json({ message: '예약이 삭제되었습니다.' });
      return;
    } catch (err) {
      res.status(500).json({ message: '예약 삭제 실패' });
      return;
    }
  };
  export const updateIsAdmin = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        res.status(404).json({ message: '유저를 찾을수 없습니다.' });
        return;
      }
  
      if (typeof req.body.isAdmin !== 'boolean') {
        res.status(400).json({ message: 'isAdmin는 boolean이여야 합니다.' });
        return;
      }
  
      user.isAdmin = req.body.isAdmin;
      await user.save();
  
      res.json({ message: 'updated', isAdmin: user.isAdmin });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: '서버 오류' });
    }
  };

  export const getAllAdminUsers = async (_req: Request, res: Response) => {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  };

  export const deleteUserById = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    await User.findByIdAndDelete(id);
    res.json({ ok: true });
  };

  export const getAdminBookingDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const bookingId = req.params.id;

    const booking = await Booking.findById(bookingId)
      .populate('serviceType', 'label')
      .populate('subtype', 'name')
      .populate('options.option', 'label')
      .lean();

    if (!booking) {
      res.status(404).json({ message: '예약을 찾을 수 없습니다.' });
      return;
    }

    const result = {
  _id: booking._id,
  serviceLabel: (booking.serviceType as any)?.label ?? '',
  subtype: (booking.subtype as any)?.name ?? '',
  reservationDate: booking.reservationDate,
  reservationTime: booking.reservationTime,
  totalPrice: booking.totalPrice,
  status: booking.status,
  memo: booking.memo ?? '',
  symptom: booking.symptom ?? '',
  tier: booking.tier ?? '',
  name: booking.name ?? '',
  isGuest: booking.isGuest,
  options: (booking.options ?? []).map(opt => ({
    option: typeof opt.option === 'object' ? (opt.option as any).label : opt.option,
    choice: opt.choice,
  })),
};
    res.json(result);
  } catch (err) {
    console.error('❌ 관리자 예약 상세 조회 실패:', err);
    res.status(500).json({ message: '예약 상세 정보를 불러오는데 실패했습니다.' });
  }
};
