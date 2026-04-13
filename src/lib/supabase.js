const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const globalSupabase = globalThis;

if (!globalSupabase.__clinicCrmSupabaseAdminClient) {
  globalSupabase.__clinicCrmSupabaseAdminClient = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

const supabase = globalSupabase.__clinicCrmSupabaseAdminClient;

module.exports = supabase;
