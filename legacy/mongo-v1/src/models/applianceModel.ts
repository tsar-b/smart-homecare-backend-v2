// src/models/applianceModel.ts

import mongoose, { Document, Schema } from 'mongoose';

//Category
export interface ICategory extends Document {
  name: string;
}

const categorySchema = new Schema<ICategory>({
  name: { type: String, required: true }
});
export const Category = mongoose.model<ICategory>('Category', categorySchema);

//ServiceType
export interface IServiceType extends Document {
  name: string;
  label: string;
}

const serviceTypeSchema = new Schema<IServiceType>({
  name: { type: String, required: true },
  label: { type: String, required: true }
});
export const ServiceType = mongoose.model<IServiceType>('ServiceType', serviceTypeSchema, 'servicetypes');

//Subtype
export interface ISubtype extends Document {
  name: string;
  category: mongoose.Types.ObjectId;
  serviceOptions: mongoose.Types.ObjectId[];
  iconUrl: string;
  memo: string;
}

const subtypeSchema = new Schema<ISubtype>({
  name: { type: String, required: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  serviceOptions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceType' }],
  iconUrl: { type: String, required: false },
    memo: {type: String, required: false }
});
export const Subtype = mongoose.model<ISubtype>('Subtype', subtypeSchema);

//Pricing
export interface IPricing extends Document {
  subtype: mongoose.Types.ObjectId;
  serviceType: mongoose.Types.ObjectId;
  tier: string;
  price: number;
  memo: string;
}

const pricingSchema = new Schema<IPricing>({
  subtype: { type: mongoose.Schema.Types.ObjectId, ref: 'Subtype', required: true },
  serviceType: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceType', required: true },
  tier: { type: String, enum: ['standard', 'deluxe', 'premium'], required: false },
  price: { type: Number, required: true },
  memo: {type: String, required: false}
});
export const Pricing = mongoose.model<IPricing>('Pricing', pricingSchema);

//Option
export interface IOption extends Document {
  key: string;
  label: string;
  appliesTo: mongoose.Types.ObjectId[];
  serviceTypes: mongoose.Types.ObjectId[];
  choices: {
    value: string;
    label: string;
    extraCost: number;
  }[];
}

const optionSchema = new Schema<IOption>({
  key: { type: String, required: true },
  label: { type: String, required: true },
  appliesTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subtype' }],
  serviceTypes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceType' }],
  choices: [{
    value: String,
    label: String,
    extraCost: Number
  }]
});
export const Option = mongoose.model<IOption>('Option', optionSchema);

//Asset
export type AssetKind = 'blueprint' | 'part' | 'video' | 'manual';

export interface IAsset extends Document {
  subtype: mongoose.Types.ObjectId;
  serviceType: mongoose.Types.ObjectId;
  kind: AssetKind;
  tier?: string;
  partId?: string;
  label?: string;
  url: string;
  steps?: string[];
}

const assetSchema = new Schema<IAsset>({
  subtype: { type: mongoose.Schema.Types.ObjectId, ref: 'Subtype', required: true },
  serviceType: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceType', required: true },
  kind: { type: String, enum: ['blueprint', 'part', 'video', 'manual'], required: true },
  tier: { type: String },
  partId: { type: String },
  label: { type: String },
  url: { type: String, required: true },
  steps: [String]
});
export const Asset = mongoose.model<IAsset>('Asset', assetSchema);

//TimeSlot
export interface ITimeSlot extends Document {
  date: Date | null;
  type: string;
  slots: string[];
}

const timeSlotSchema = new Schema<ITimeSlot>({
  date: { type: Date, default: null },
  type: { type: String, required: true },
  slots: [{ type: String }]
});
export const TimeSlot = mongoose.model<ITimeSlot>('TimeSlot', timeSlotSchema);
