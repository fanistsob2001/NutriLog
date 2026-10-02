// NutriLog — Edge Function "account"
// Οριστική διαγραφή του λογαριασμού του συνδεδεμένου χρήστη. Τα δεδομένα του
// (user_data, ai_usage, push_subscriptions) σβήνονται αυτόματα μέσω ON DELETE CASCADE·
// η φωτογραφία προφίλ (Storage, bucket "avatars") σβήνεται ρητά.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    const userClient = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!user) return json(401, { error: 'Πρέπει να συνδεθείς.' });

    const body = await req.json().catch(() => ({}));
    if (body.action !== 'delete' || body.confirm !== 'ΔΙΑΓΡΑΦΗ') return json(400, { error: 'Λείπει η επιβεβαίωση.' });

    const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
    // Οι φωτογραφίες προφίλ δεν σβήνονται με CASCADE, οπότε τις αφαιρούμε πρώτα.
    const { data: files } = await admin.storage.from('avatars').list(user.id, { limit: 100 });
    if (files?.length) await admin.storage.from('avatars').remove(files.map((f) => `${user.id}/${f.name}`));
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw error;
    return json(200, { deleted: true });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Η διαγραφή απέτυχε. Δοκίμασε ξανά.' });
  }
});
