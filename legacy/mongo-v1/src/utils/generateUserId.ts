// src/utils/generateUserId.ts

import Counter from '../models/Counter';
import User from '../models/User';

export const generateUserId = async (): Promise<number> => {
  const maxCounter = await Counter.findById('userId');
  const maxId = maxCounter?.seq ?? 0;

  const existing = await User.find({ userId: { $lte: maxId } }, 'userId').lean();
  const taken = new Set(existing.map(u => u.userId));

  for (let i = 1; i <= maxId; i++) {
    if (!taken.has(i)) return i;
  }

  // No gap, increment counter
  const counter = await Counter.findByIdAndUpdate(
    'userId',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return counter.seq;
};
