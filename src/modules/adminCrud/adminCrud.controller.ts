import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { clearInitializeCache } from '../appInitialize/appInitialize.controller.js';
import { PROFILE_SELECT, publicProfile } from '../auth/auth.service.js';
import { toBookingResponse } from '../bookings/booking.controller.js';
import {
  purgeAttachmentsForBooking,
  purgeAttachmentsForUser
} from '../bookingAttachments/bookingAttachment.service.js';

type AdminResource = {
  dateField?: string;
  searchFields?: string[];
  sortFields: string[];
  statusField?: string;
  table?: string;
  writableFields?: string[];
};

const ADMIN_RESOURCES: Record<string, AdminResource> = {
  requests: {
    dateField: 'reservation_date',
    searchFields: ['name', 'phone', 'address'],
    sortFields: ['reservation_date', 'created_at', 'status', 'total_price'],
    statusField: 'status'
  },
  assets: {
    sortFields: ['id', 'label', 'kind', 'tier'],
    writableFields: ['service_type', 'kind', 'tier', 'part_id', 'subtype', 'label', 'steps', 'url']
  },
  categories: {
    table: 'catalog_categories',
    sortFields: ['sort_order', 'created_at', 'label'],
    writableFields: ['key', 'label', 'sort_order', 'metadata']
  },
  options: {
    table: 'request_options',
    sortFields: ['sort_order', 'created_at', 'label'],
    writableFields: ['service_type_id', 'key', 'label', 'extra_cost', 'applies_to', 'choices', 'service_types', 'sort_order', 'metadata']
  },
  pricings: {
    table: 'pricing_tiers',
    sortFields: ['sort_order', 'created_at', 'label', 'base_price'],
    writableFields: ['service_type_id', 'service_type', 'subtype', 'key', 'label', 'base_price', 'sort_order', 'memo', 'metadata']
  },
  servicetypes: {
    table: 'service_types',
    sortFields: ['sort_order', 'created_at', 'label'],
    writableFields: ['category_id', 'key', 'label', 'sort_order', 'metadata']
  },
  subtypes: {
    sortFields: ['id', 'label'],
    writableFields: ['key', 'label', 'category', 'icon_url', 'service_options']
  },
  timeslots: {
    sortFields: ['date', 'id'],
    writableFields: ['date', 'type', 'slots']
  },
  audit_logs: { dateField: 'created_at', sortFields: ['created_at', 'table_name', 'action'] }
};

export async function listAdminBookings(_req: Request, res: Response) {
  const rows = await readAdminBookings();
  res.json(rows);
}

export async function filterAdminBookings(req: Request, res: Response) {
  const rows = await readAdminBookings({
    start: String(req.body.start ?? req.body.startDate),
    end: String(req.body.end ?? req.body.endDate),
    status: req.body.status
  });
  res.json(rows);
}

export async function getAdminBooking(req: Request, res: Response) {
  const id = paramValue(req.params.id);
  const { data, error } = await supabaseAdmin.from('bookings').select('*').eq('id', id).maybeSingle();
  if (error || !data) throw new HttpError(404, 'Booking not found', 'BOOKING_NOT_FOUND');
  const [enriched] = await enrichBookings([data]);
  res.json(enriched);
}

export async function updateAdminBooking(req: Request, res: Response) {
  const id = paramValue(req.params.id);
  const patch = {
    ...(req.body.status !== undefined ? { status: req.body.status } : {}),
    ...(req.body.totalPrice !== undefined || req.body.total_price !== undefined
      ? { total_price: req.body.totalPrice ?? req.body.total_price }
      : {}),
    ...(req.body.options !== undefined ? { options: req.body.options } : {})
  };
  const { data, error } = await supabaseAdmin.from('bookings').update(patch).eq('id', id).select('*').maybeSingle();
  if (error) throw new HttpError(400, error.message, 'BOOKING_UPDATE_FAILED');
  if (!data) throw new HttpError(404, 'Booking not found', 'BOOKING_NOT_FOUND');
  await writeAuditLog(req, 'bookings', id, 'update', patch);
  res.json(toBookingResponse(data));
}

export async function deleteAdminBooking(req: Request, res: Response) {
  const id = paramValue(req.params.id);
  const { data: existing, error: readError } = await supabaseAdmin
    .from('bookings')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw new HttpError(400, readError.message, 'BOOKING_DELETE_FAILED');
  if (!existing) throw new HttpError(404, 'Booking not found', 'BOOKING_NOT_FOUND');

  const { data, error } = await purgeMediaBeforeDestructiveDelete(
    () => purgeAttachmentsForBooking(id),
    async () => await supabaseAdmin.from('bookings').delete().eq('id', id).select('id').maybeSingle()
  );
  if (error) throw new HttpError(400, error.message, 'BOOKING_DELETE_FAILED');
  if (!data) throw new HttpError(404, 'Booking not found', 'BOOKING_NOT_FOUND');
  await writeAuditLog(req, 'bookings', id, 'delete');
  res.json({ ok: true });
}

export async function listAdminUsers(_req: Request, res: Response) {
  const { data, error } = await supabaseAdmin.from('users').select(PROFILE_SELECT).order('created_at', { ascending: false });
  if (error) throw new HttpError(400, error.message, 'ADMIN_USERS_FAILED');
  res.json((data ?? []).map((profile) => publicProfile(profile as any)));
}

export async function updateAdminRole(req: Request, res: Response) {
  const id = paramValue(req.params.id);
  const isAdmin = Boolean(req.body.isAdmin ?? req.body.is_admin);
  if (id === req.user!.id && !isAdmin) {
    throw new HttpError(409, 'You cannot remove your own admin access', 'ADMIN_SELF_DEMOTION');
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ is_admin: isAdmin })
    .eq('id', id)
    .select(PROFILE_SELECT)
    .maybeSingle();
  if (error) throw new HttpError(400, error.message, 'ADMIN_ROLE_UPDATE_FAILED');
  if (!data) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  await writeAuditLog(req, 'users', id, 'update', { is_admin: isAdmin });
  res.json({ message: 'updated', isAdmin, user: publicProfile(data as any) });
}

export async function deleteAdminUser(req: Request, res: Response) {
  const id = paramValue(req.params.id);
  if (id === req.user!.id) throw new HttpError(409, 'You cannot delete your own admin account', 'ADMIN_SELF_DELETE');

  const { data: profile, error: readError } = await supabaseAdmin
    .from('users')
    .select('id, auth_user_id')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw new HttpError(400, readError.message, 'ADMIN_USER_DELETE_FAILED');
  if (!profile) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');

  const deletion = await purgeMediaBeforeDestructiveDelete(
    () => purgeAttachmentsForUser(id),
    async () => {
      if (profile.auth_user_id) return supabaseAdmin.auth.admin.deleteUser(profile.auth_user_id);
      return await supabaseAdmin.from('users').delete().eq('id', id);
    }
  );
  if (deletion.error) throw new HttpError(400, deletion.error.message, 'ADMIN_USER_DELETE_FAILED');
  await writeAuditLog(req, 'users', id, 'delete');
  res.json({ ok: true });
}

export async function listRows(req: Request, res: Response) {
  const resourceName = paramValue(req.params.table);
  const resource = assertTable(resourceName);
  const table = resource.table ?? resourceName;
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 25);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin.from(table).select('*', { count: 'exact' });

  if (resource.statusField && req.query.status) {
    query = query.eq(resource.statusField, String(req.query.status));
  }

  if (resource.dateField && req.query.dateFrom) {
    query = query.gte(resource.dateField, String(req.query.dateFrom));
  }

  if (resource.dateField && req.query.dateTo) {
    query = query.lte(resource.dateField, String(req.query.dateTo));
  }

  if (resource.searchFields?.length && req.query.search) {
    const search = escapeFilterValue(String(req.query.search));
    query = query.or(resource.searchFields.map((field) => `${field}.ilike.%${search}%`).join(','));
  }

  const requestedSort = req.query.sort ? String(req.query.sort) : resource.sortFields[0];
  const sort = resource.sortFields.includes(requestedSort) ? requestedSort : resource.sortFields[0];
  const ascending = req.query.direction === 'asc';
  const { data, error, count } = await query.order(sort, { ascending }).range(from, to);

  if (error) throw new HttpError(400, error.message, 'ADMIN_LIST_FAILED');
  res.json({
    data: data ?? [],
    page,
    pageSize,
    total: count ?? 0
  });
}

export async function updateRow(req: Request, res: Response) {
  const resourceName = paramValue(req.params.table);
  const resource = assertTable(resourceName);
  const table = resource.table ?? resourceName;
  const rowId = paramValue(req.params.id);
  const patch = Object.fromEntries(
    Object.entries(req.body).filter(([field]) => resource.writableFields?.includes(field))
  );
  if (!Object.keys(patch).length || Object.keys(patch).length !== Object.keys(req.body).length) {
    throw new HttpError(400, 'Request contains unsupported fields', 'ADMIN_PATCH_INVALID');
  }
  const { data, error } = await supabaseAdmin
    .from(table)
    .update(patch)
    .eq('id', rowId)
    .select('*')
    .maybeSingle();

  if (error) throw new HttpError(400, error.message, 'ADMIN_UPDATE_FAILED');
  if (!data) throw new HttpError(404, 'Admin resource row not found', 'ADMIN_ROW_NOT_FOUND');
  await writeAuditLog(req, table, rowId, 'update', patch);
  clearInitializeCache();
  res.json(data);
}

export async function createRow(req: Request, res: Response) {
  const resourceName = paramValue(req.params.table);
  const resource = assertTable(resourceName);
  const table = resource.table ?? resourceName;
  const values = Object.fromEntries(
    Object.entries(req.body).filter(([field]) => resource.writableFields?.includes(field))
  );
  if (!resource.writableFields || !Object.keys(values).length || Object.keys(values).length !== Object.keys(req.body).length) {
    throw new HttpError(400, 'Request contains unsupported fields', 'ADMIN_CREATE_INVALID');
  }

  const rowId = randomUUID();
  const { data, error } = await supabaseAdmin
    .from(table)
    .insert({ id: rowId, ...values })
    .select('*')
    .single();
  if (error) throw new HttpError(400, error.message, 'ADMIN_CREATE_FAILED');
  await writeAuditLog(req, table, rowId, 'create', values);
  clearInitializeCache();
  res.status(201).json(data);
}

export async function deleteRow(req: Request, res: Response) {
  const resourceName = paramValue(req.params.table);
  const resource = assertTable(resourceName);
  const table = resource.table ?? resourceName;
  const rowId = paramValue(req.params.id);
  const { data, error } = await supabaseAdmin.from(table).delete().eq('id', rowId).select('id').maybeSingle();
  if (error) throw new HttpError(400, error.message, 'ADMIN_DELETE_FAILED');
  if (!data) throw new HttpError(404, 'Admin resource row not found', 'ADMIN_ROW_NOT_FOUND');
  await writeAuditLog(req, table, rowId, 'delete');
  clearInitializeCache();
  res.json({ ok: true });
}

function assertTable(table: string) {
  if (!ADMIN_RESOURCES[table]) {
    throw new HttpError(404, 'Unknown admin table', 'UNKNOWN_TABLE');
  }
  return ADMIN_RESOURCES[table];
}

function paramValue(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function escapeFilterValue(value: string) {
  return value.replaceAll('%', '\\%').replaceAll(',', '\\,');
}

async function writeAuditLog(
  req: Request,
  table: string,
  rowId: string,
  action: 'create' | 'update' | 'delete',
  patch?: unknown
) {
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    actor_id: req.user?.id ?? null,
    table_name: table,
    row_id: rowId,
    action,
    patch: patch ?? null
  });

  if (error) {
    logger.warn({ error, table, rowId, action }, 'Admin audit log write failed');
  }
}

async function readAdminBookings(filters?: { start?: string; end?: string; status?: string }) {
  let query = supabaseAdmin.from('bookings').select('*').order('reservation_date', { ascending: false }).limit(500);
  if (filters?.start) query = query.gte('reservation_date', filters.start);
  if (filters?.end) query = query.lte('reservation_date', filters.end);
  if (filters?.status) query = query.eq('status', filters.status);
  const { data, error } = await query;
  if (error) throw new HttpError(400, error.message, 'ADMIN_BOOKINGS_FAILED');
  return enrichBookings(data ?? []);
}

export async function purgeMediaBeforeDestructiveDelete<T>(
  purge: () => Promise<unknown>,
  destructiveDelete: () => Promise<T>
) {
  await purge();
  return destructiveDelete();
}

async function enrichBookings(bookings: Record<string, any>[]) {
  const userIds = [...new Set(bookings.map((booking) => booking.user_id).filter(Boolean))];
  const { data: users, error } = userIds.length
    ? await supabaseAdmin.from('users').select('id, phone, address, address_detail').in('id', userIds)
    : { data: [], error: null };
  if (error) throw new HttpError(400, error.message, 'ADMIN_BOOKING_USERS_FAILED');
  const usersById = new Map((users ?? []).map((user) => [user.id, user]));
  return bookings.map((booking) => {
    const user = usersById.get(booking.user_id);
    return {
      ...toBookingResponse(booking),
      userAddress: user ? [user.address, user.address_detail].filter(Boolean).join(' ') : null,
      userPhone: user?.phone ?? booking.phone ?? null
    };
  });
}
