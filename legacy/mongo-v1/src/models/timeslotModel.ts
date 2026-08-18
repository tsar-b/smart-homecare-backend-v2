// src/models/timeslotModel.ts

import mongoose, { Schema, model, Types } from 'mongoose';

interface ITimeSlot {
  date: Date | null;
  type: string;
  slots: { time: string }[];
}

const TimeSlotSchema = new Schema<ITimeSlot>({
  date: { type: Date, default: null },
  type: { type: String, required: true },
  slots: [
    {
      time: { type: String, required: true }
    }
  ]
});

export const TimeSlot = (mongoose.models.TimeSlot as mongoose.Model<ITimeSlot>) || model<ITimeSlot>('TimeSlot', TimeSlotSchema);



