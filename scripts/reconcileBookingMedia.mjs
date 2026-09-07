import { reconcileBookingAttachments } from '../dist/modules/bookingAttachments/bookingAttachment.service.js';

const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='));
const limit = limitArgument ? Number(limitArgument.slice('--limit='.length)) : 100;
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  throw new Error('--limit must be an integer from 1 to 500');
}

const result = await reconcileBookingAttachments(limit);
console.log(JSON.stringify(result, null, 2));
if (result.failed > 0) process.exitCode = 1;
