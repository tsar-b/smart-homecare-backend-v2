export const BOOKING_IMAGE_BUCKET = 'shc-booking-images-v1';
export const BOOKING_VIDEO_BUCKET = 'shc-booking-videos-v1';

export const MAX_BOOKING_ATTACHMENTS = 6;
export const MAX_BOOKING_VIDEOS = 2;
export const MAX_BOOKING_ATTACHMENT_BYTES = 100_000_000;
export const MAX_IMAGE_BYTES = 10_000_000;
export const MAX_VIDEO_BYTES = 45_000_000;
export const MAX_USER_MEDIA_RESERVATIONS = 12;
export const MAX_USER_MEDIA_RESERVED_BYTES = 100_000_000;
export const BOOKING_ATTACHMENT_INTENT_RATE_LIMIT = 12;
export const BOOKING_ATTACHMENT_INTENT_RATE_WINDOW_MS = 60_000;
export const STANDARD_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
export const TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;
export const SIGNED_UPLOAD_TTL_SECONDS = 2 * 60 * 60;
export const SIGNED_UPLOAD_REQUEST_TIMEOUT_MS = 30_000;
export const SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;
export const TUS_WRITE_TTL_SECONDS = 24 * 60 * 60;
export const STORAGE_WRITE_EXPIRY_GRACE_SECONDS = 5 * 60;
export const BOOKING_MEDIA_CACHE_CONTROL = '0';

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const BOOKING_MEDIA_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;

export type BookingMediaKind = 'image' | 'video';
export type BookingAttachmentStatus = 'pending' | 'ready' | 'deleting' | 'rejected';
export type BookingUploadMethod = 'signed_put' | 'tus';

const EXTENSION_BY_MIME_TYPE: Record<(typeof BOOKING_MEDIA_MIME_TYPES)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov'
};

export function normalizeMediaContentType(value: string) {
  return value.split(';', 1)[0].trim().toLowerCase();
}

export function mediaKindForContentType(contentType: string): BookingMediaKind | null {
  const normalized = normalizeMediaContentType(contentType);
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(normalized)) return 'image';
  if ((VIDEO_MIME_TYPES as readonly string[]).includes(normalized)) return 'video';
  return null;
}

export function mediaBucketForKind(kind: BookingMediaKind) {
  return kind === 'image' ? BOOKING_IMAGE_BUCKET : BOOKING_VIDEO_BUCKET;
}

export function mediaExtensionForContentType(contentType: string) {
  const normalized = normalizeMediaContentType(contentType) as keyof typeof EXTENSION_BY_MIME_TYPE;
  return EXTENSION_BY_MIME_TYPE[normalized];
}

export function mediaSizeLimitForKind(kind: BookingMediaKind) {
  return kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
}

export function uploadMethodForSize(sizeBytes: number): BookingUploadMethod {
  return sizeBytes <= STANDARD_UPLOAD_MAX_BYTES ? 'signed_put' : 'tus';
}

export function createBookingMediaObjectPath(attachmentId: string, contentType: string) {
  const extension = mediaExtensionForContentType(contentType);
  if (!extension) throw new Error('Unsupported booking media content type');
  return `v1/${attachmentId.slice(0, 2)}/${attachmentId}.${extension}`;
}

export function deriveTusEndpoint(supabaseUrl: string) {
  const url = new URL(supabaseUrl);
  if (url.hostname.endsWith('.supabase.co') && !url.hostname.endsWith('.storage.supabase.co')) {
    url.hostname = url.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co');
  }
  // Signed resumable uploads use the dedicated /sign TUS creation endpoint
  // together with the path-bound token in x-signature.
  url.pathname = '/storage/v1/upload/resumable/sign';
  url.search = '';
  url.hash = '';
  return url.toString();
}
