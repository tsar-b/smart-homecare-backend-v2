import { createClient } from '@supabase/supabase-js';
import { env } from '../core/env.js';

const backendKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

if (!backendKey) throw new Error('Supabase backend key is not configured');

export const supabaseAdmin = createClient(env.SUPABASE_URL, backendKey, {
  auth: {
    persistSession: false
  }
});
