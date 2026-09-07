import { z } from 'zod';
import {
  BOOKING_MEDIA_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  mediaKindForContentType,
  normalizeMediaContentType
} from './bookingAttachment.constants.js';

export const BookingAttachmentBookingParamsSchema = z
  .object({
    bookingId: z.string().min(1).max(200)
  })
  .strict();

export const BookingAttachmentParamsSchema = BookingAttachmentBookingParamsSchema.extend({
  attachmentId: z.string().uuid()
}).strict();

export const CreateBookingAttachmentIntentSchema = z
  .object({
    clientAttachmentId: z.string().uuid(),
    kind: z.enum(['image', 'video']),
    contentType: z
      .string()
      .transform(normalizeMediaContentType)
      .refine((value) => (BOOKING_MEDIA_MIME_TYPES as readonly string[]).includes(value), {
        message: 'Unsupported media content type'
      }),
    sizeBytes: z.number().int().positive()
  })
  .strict()
  .superRefine((value, context) => {
    const detectedKind = mediaKindForContentType(value.contentType);
    if (detectedKind !== value.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Media kind does not match content type',
        path: ['contentType']
      });
    }

    const limit = value.kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (value.sizeBytes > limit) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: limit,
        inclusive: true,
        type: 'number',
        message: `${value.kind} exceeds the ${limit}-byte limit`,
        path: ['sizeBytes']
      });
    }
  });
