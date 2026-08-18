import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

type AdminResource = {
  dateField?: string;
  searchFields?: string[];
  sortFields: string[];
  statusField?: string;
};

const ADMIN_RESOURCES: Record<string, AdminResource> = {
  users: {
    searchFields: ['name', 'email', 'phone'],
    sortFields: ['created_at', 'name', 'email'],
  },
  requests: {
    dateField: 'reservation_date',
    searchFields: ['name', 'phone', 'address'],
    sortFields: ['reservation_date', 'created_at', 'status', 'total_price'],
    statusField: 'status'
  },
  bookings: {
    dateField: 'reservation_date',
    searchFields: ['name', 'phone', 'address'],
    sortFields: ['reservation_date', 'created_at', 'status', 'total_price'],
    statusField: 'status'
  },
  assets: { sortFields: ['created_at', 'name'] },
  categories: { sortFields: ['created_at', 'name'] },
  options: { sortFields: ['created_at', 'name'] },
  pricings: { sortFields: ['created_at', 'name', 'price'] },
  servicetypes: { sortFields: ['created_at', 'name'] },
  subtypes: { sortFields: ['created_at', 'name'] },
  timeslots: { sortFields: ['created_at', 'time', 'start_time'] },
  audit_logs: { dateField: 'created_at', sortFields: ['created_at', 'table_name', 'action'] }
};

export async function listRows(req: Request, res: Response) {
  const table = assertTable(paramValue(req.params.table));
  const resource = ADMIN_RESOURCES[table];
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
  const table = assertTable(paramValue(req.params.table));
  const rowId = paramValue(req.params.id);
  const { data, error } = await supabaseAdmin
    .from(table)
    .update(req.body)
    .eq('id', rowId)
    .select('*')
    .single();

  if (error) throw new HttpError(400, error.message, 'ADMIN_UPDATE_FAILED');
  await writeAuditLog(req, table, rowId, 'update', req.body);
  res.json(data);
}

export async function deleteRow(req: Request, res: Response) {
  const table = assertTable(paramValue(req.params.table));
  const rowId = paramValue(req.params.id);
  const { error } = await supabaseAdmin.from(table).delete().eq('id', rowId);
  if (error) throw new HttpError(400, error.message, 'ADMIN_DELETE_FAILED');
  await writeAuditLog(req, table, rowId, 'delete');
  res.json({ ok: true });
}

function assertTable(table: string) {
  if (!ADMIN_RESOURCES[table]) {
    throw new HttpError(404, 'Unknown admin table', 'UNKNOWN_TABLE');
  }
  return table;
}

function paramValue(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function escapeFilterValue(value: string) {
  return value.replaceAll('%', '\\%').replaceAll(',', '\\,');
}

async function writeAuditLog(req: Request, table: string, rowId: string, action: 'update' | 'delete', patch?: unknown) {
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
