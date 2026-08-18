// src/controllers/bookingController.ts

import { Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  Subtype,
  ServiceType,
  Option,
  Pricing,
  Asset,
  TimeSlot,
} from '../models/applianceModel';

export const getBookingInitializeData = async (req: Request, res: Response): Promise<void> => {
  try {
    const [subtypes, options, pricings, assets, timeSlots, services] = await Promise.all([
      Subtype.find().populate('category serviceOptions'),
      Option.find(),
      Pricing.find(),
      Asset.find(),
      TimeSlot.find(),
      ServiceType.find(),
    ]);

    const structuredSubtypes = await Promise.all(
      subtypes.map(async (subtype) => {
        const subtypeId = subtype._id as Types.ObjectId;

        const enrichedServices = await Promise.all(
          subtype.serviceOptions.map(async (service) => {
            if (!service || typeof service !== 'object' || !service._id) return null;

            const serviceId = new Types.ObjectId(service._id);
            const fullService = services.find(s => String(s._id) === String(serviceId));
            if (!fullService) return null;

            const matchedPricings = pricings.filter(
              (p) => p.subtype.equals(subtypeId) && p.serviceType.equals(serviceId)
            );

            const tiers = matchedPricings.length > 0
              ? matchedPricings.map((pr) => {
                  const blueprint = assets.find(
                    (a) =>
                      a.subtype.equals(subtypeId) &&
                      a.serviceType.equals(serviceId) &&
                      a.kind === 'blueprint' &&
                      a.tier === pr.tier
                  );

                  const parts = assets.filter(
                    (a) =>
                      a.subtype.equals(subtypeId) &&
                      a.serviceType.equals(serviceId) &&
                      a.kind === 'part' &&
                      a.tier === pr.tier
                  );

                  return {
                    tier: pr.tier,
                    price: pr.price,
                     memo: pr.memo || null,
                    assets: {
                      blueprint: blueprint?.url || null,
                      parts: parts.map((p) => ({
                        label: p.label,
                        partId: p.partId,
                        url: p.url,
                      })),
                    },
                  };
                })
              : [
                  {
                    tier: 'standard',
                    price: -1, // 가격문의 fallback
                    extraTime: 0,
                    assets: {
                      blueprint: null,
                      parts: [],
                    },
                  },
                ];

            const relatedOptions = options
              .filter(
                (opt) =>
                  opt.appliesTo.some((id) => String(id) === String(subtypeId)) &&
                  opt.serviceTypes?.some((id) => String(id) === String(serviceId))
              )
              .map((opt) => ({
                _id: opt._id,
                key: opt.key,
                label: opt.label,
                choices: opt.choices,
              }));

            return {
              _id: fullService._id,
              name: fullService.name,
              label: fullService.label,
              tiers,
              options: relatedOptions,
            };
          })
        );

        const filteredServices = enrichedServices.filter((svc) => svc !== null);

        return {
          _id: subtype._id,
          name: subtype.name,
          iconUrl: subtype.iconUrl,
          category: subtype.category,
          serviceOptions: filteredServices,
        };
      })
    );

    res.json({
      subtypes: structuredSubtypes,
      timeSlots,
    });
  } catch (err) {
    console.error('Error in /booking/initialize:', err);
    res.status(500).json({ message: '데이터를 불러오는데 실패했습니다.' });
  }
};
