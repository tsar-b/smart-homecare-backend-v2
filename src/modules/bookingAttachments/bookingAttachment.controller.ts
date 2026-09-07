import type { Request, Response } from 'express';
import {
  completeAttachment,
  createAttachmentIntent,
  deleteBookingAttachment,
  getAttachmentDownloadUrl,
  listBookingAttachments,
  writeBookingAttachmentAudit
} from './bookingAttachment.service.js';

export async function createBookingAttachmentIntent(req: Request, res: Response) {
  noStore(res);
  const result = await createAttachmentIntent({
    bookingId: paramValue(req.params.bookingId),
    ownerUserId: req.user!.id,
    clientAttachmentId: req.body.clientAttachmentId,
    kind: req.body.kind,
    contentType: req.body.contentType,
    sizeBytes: req.body.sizeBytes
  });
  res.status(result.created ? 201 : 200).json(result.body);
}

export async function completeBookingAttachment(req: Request, res: Response) {
  noStore(res);
  res.json(
    await completeAttachment(
      paramValue(req.params.bookingId),
      paramValue(req.params.attachmentId),
      { type: 'owner', userId: req.user!.id }
    )
  );
}

export async function listCustomerBookingAttachments(req: Request, res: Response) {
  noStore(res);
  res.json(
    await listBookingAttachments(paramValue(req.params.bookingId), {
      type: 'owner',
      userId: req.user!.id
    })
  );
}

export async function getCustomerAttachmentDownloadUrl(req: Request, res: Response) {
  noStore(res);
  res.json(
    await getAttachmentDownloadUrl(
      paramValue(req.params.bookingId),
      paramValue(req.params.attachmentId),
      { type: 'owner', userId: req.user!.id }
    )
  );
}

export async function deleteCustomerBookingAttachment(req: Request, res: Response) {
  noStore(res);
  await deleteBookingAttachment(
    paramValue(req.params.bookingId),
    paramValue(req.params.attachmentId),
    { type: 'owner', userId: req.user!.id }
  );
  res.status(204).end();
}

export async function listAdminBookingAttachments(req: Request, res: Response) {
  noStore(res);
  const bookingId = paramValue(req.params.bookingId);
  const attachments = await listBookingAttachments(bookingId, { type: 'admin' });
  await writeBookingAttachmentAudit(req.user!.id, bookingId, 'media_list', {
    bookingId,
    attachmentCount: attachments.filter((attachment) => attachment.status === 'ready').length
  });
  res.json(attachments);
}

export async function getAdminAttachmentDownloadUrl(req: Request, res: Response) {
  noStore(res);
  const bookingId = paramValue(req.params.bookingId);
  const attachmentId = paramValue(req.params.attachmentId);
  const signed = await getAttachmentDownloadUrl(bookingId, attachmentId, { type: 'admin' });
  await writeBookingAttachmentAudit(req.user!.id, attachmentId, 'media_download_signed', { bookingId });
  res.json(signed);
}

export async function deleteAdminBookingAttachment(req: Request, res: Response) {
  noStore(res);
  const bookingId = paramValue(req.params.bookingId);
  const attachmentId = paramValue(req.params.attachmentId);
  await deleteBookingAttachment(
    bookingId,
    attachmentId,
    { type: 'admin' }
  );
  await writeBookingAttachmentAudit(req.user!.id, attachmentId, 'media_delete', { bookingId });
  res.status(204).end();
}

function paramValue(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}
