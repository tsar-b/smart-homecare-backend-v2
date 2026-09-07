import { createClient } from '@supabase/supabase-js';
import { env } from '../core/env.js';

const resolvedPublicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;

if (!resolvedPublicKey) throw new Error('Supabase publishable key is not configured');

const publicKey: string = resolvedPublicKey;

export function createSupabasePublicClient() {
  return createClient(env.SUPABASE_URL, publicKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    }
  });
}
