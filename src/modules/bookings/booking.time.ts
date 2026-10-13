// SHC slots are business-local wall-clock values, not the caller's local time.
// Keep this policy shared by availability, validation and booking persistence.
export const BOOKING_TIMEZONE = 'Asia/Seoul';

export function bookingDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: BOOKING_TIMEZONE,
    year: 'numeric'
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`
  };
}
