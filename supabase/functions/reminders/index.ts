// NutriLog — Edge Function "reminders"
// Στέλνει ειδοποιήσεις push (Web Push / VAPID).
//  - action "cron": καλείται κάθε 15' από το pg_cron (με x-cron-secret) και στέλνει όσες
//    υπενθυμίσεις «λήγουν» τώρα, στην τοπική ώρα κάθε χρήστη.
//  - action "test": ο συνδεδεμένος χρήστης ζητά δοκιμαστική ειδοποίηση στις συσκευές του.
// Τα κλειδιά (VAPID, cron secret) βρίσκονται στον πίνακα public.app_secrets,
// που διαβάζεται μόνο με το service role.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const APP_URL = 'https://fanistsob2001.github.io/NutriLog/';
const WINDOW_MIN = 20; // το cron τρέχει κάθε 15', αφήνουμε λίγο περιθώριο

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

async function secrets(): Promise<Record<string, string>> {
  const { data, error } = await admin.from('app_secrets').select('name,value');
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r: { name: string; value: string }) => [r.name, r.value]));
}

type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string; tz: string; prefs: Record<string, any>; last_sent: Record<string, string> };

async function send(sub: Sub, payload: Record<string, unknown>, keys: Record<string, string>) {
  const details = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { vapidDetails: { subject: APP_URL, publicKey: keys.vapid_public, privateKey: keys.vapid_private }, TTL: 4 * 3600, urgency: 'normal' },
  );
  const res = await fetch(details.endpoint, { method: 'POST', headers: details.headers as Record<string, string>, body: details.body });
  if (res.status === 404 || res.status === 410) {
    await admin.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); // η συνδρομή έληξε
  }
  return res.status;
}

/* ---------- Ώρα & streak (ίδια λογική με την εφαρμογή) ---------- */
function localNow(tz: string, now: Date) {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(now).map((p) => [p.type, p.value]));
  } catch {
    return localNow('Europe/Athens', now);
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), weekday: parts.weekday };
}
const toMin = (t: unknown) => {
  const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};
const shift = (k: string, n: number) => {
  const d = new Date(k + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function dayStatus(data: any, k: string) {
  const d = data?.days?.[k];
  const frozen = !!data?.freezes?.[k];
  if (!d?.entries?.length) return frozen ? 'freeze' : 'none';
  const kcal = d.entries.reduce((a: number, e: any) => a + (Number(e.kcal) || 0), 0);
  const protein = d.entries.reduce((a: number, e: any) => a + (Number(e.protein) || 0), 0);
  const g = data.goals ?? {}, tol = (Number(data.settings?.tolerance) || 10) / 100;
  let ok = Math.abs(kcal - (g.kcal || 2000)) <= (g.kcal || 2000) * tol;
  if (ok && data.settings?.requireProtein) ok = protein >= (g.protein || 0) * 0.9;
  return ok ? 'hit' : frozen ? 'freeze' : 'miss';
}
function streakBefore(data: any, today: string) {
  let n = 0, k = shift(today, -1);
  for (let i = 0; i < 4000; i++) {
    const s = dayStatus(data, k);
    if (s === 'hit') n++;
    else if (s !== 'freeze') break;
    k = shift(k, -1);
  }
  return n;
}

const MEALS: Record<string, [string, string]> = {
  breakfast: ['🌅 Ώρα για πρωινό;', 'Μην ξεχάσεις να καταγράψεις το πρωινό σου.'],
  lunch: ['☀️ Τι έφαγες για μεσημεριανό;', 'Κατέγραψέ το τώρα — ή βγάλε μια φωτογραφία και το κάνει το AI.'],
  dinner: ['🌙 Καταγραφή βραδινού', 'Πρόσθεσε το βραδινό σου για να κλείσεις τη μέρα.'],
};

function dueReminders(sub: Sub, data: any, now: Date) {
  const p = sub.prefs ?? {};
  if (!p.enabled) return [];
  const { date, minutes, weekday } = localNow(sub.tz, now);
  const due = (t: unknown) => { const m = toMin(t); return m >= 0 && minutes >= m && minutes < m + WINDOW_MIN; };
  const sent = (key: string) => sub.last_sent?.[key] === date;
  const day = data?.days?.[date] ?? {};
  const out: { key: string; title: string; body: string; tag: string }[] = [];

  for (const [meal, [title, body]] of Object.entries(MEALS)) {
    if (p[meal] && due(p[meal]) && !sent(meal) && !(day.entries ?? []).some((e: any) => e.meal === meal)) {
      out.push({ key: meal, title, body, tag: 'meal-' + meal });
    }
  }
  const waterGoal = Number(data?.goals?.water) || 2000;
  if (p.water && due('16:00') && !sent('water') && (Number(day.water) || 0) < waterGoal * 0.5) {
    out.push({ key: 'water', title: '💧 Ώρα για νερό', body: `Έχεις πιει ${((Number(day.water) || 0) / 1000).toFixed(1).replace('.', ',')} L από ${(waterGoal / 1000).toFixed(1).replace('.', ',')} L. Ένα ποτήρι τώρα;`, tag: 'water' });
  }
  if (p.streak && due(p.streakTime || '21:30') && !sent('streak') && dayStatus(data, date) !== 'hit') {
    const n = streakBefore(data, date);
    if (n > 0) out.push({ key: 'streak', title: `🔥 Το streak των ${n} ${n === 1 ? 'ημέρας' : 'ημερών'} κινδυνεύει!`, body: 'Κατέγραψε τα γεύματά σου και μπες στο εύρος του στόχου για να το κρατήσεις.', tag: 'streak' });
  }
  if (p.weekly && weekday === 'Sun' && due('19:00') && !sent('weekly')) {
    out.push({ key: 'weekly', title: '🧠 Η εβδομάδα σου', body: 'Δες την εβδομαδιαία ανασκόπηση από τον Nutri.', tag: 'weekly' });
  }
  return out.map((r) => ({ ...r, date }));
}

async function runCron(keys: Record<string, string>) {
  const { data: subs, error } = await admin.from('push_subscriptions').select('*');
  if (error) throw error;
  if (!subs?.length) return { subs: 0, sent: 0 };
  const userIds = [...new Set(subs.map((s: Sub) => s.user_id))];
  const { data: rows } = await admin.from('user_data').select('user_id,data').in('user_id', userIds);
  const byUser = Object.fromEntries((rows ?? []).map((r: any) => [r.user_id, r.data]));
  const now = new Date();
  let sentCount = 0;
  for (const sub of subs as Sub[]) {
    const due = dueReminders(sub, byUser[sub.user_id] ?? {}, now);
    if (!due.length) continue;
    const last = { ...(sub.last_sent ?? {}) };
    for (const r of due) {
      try {
        const st = await send(sub, { title: r.title, body: r.body, tag: r.tag, url: APP_URL + (r.key === 'weekly' ? '#review' : '') }, keys);
        if (st === 404 || st === 410) break;
        if (st < 300) sentCount++;
      } catch (e) {
        console.error('push failed', e);
      }
      last[r.key] = r.date;
    }
    await admin.from('push_subscriptions').update({ last_sent: last }).eq('endpoint', sub.endpoint);
  }
  return { subs: subs.length, sent: sentCount };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const keys = await secrets();
    const body = await req.json().catch(() => ({}));

    if (body.action === 'cron') {
      if (!keys.cron_secret || req.headers.get('x-cron-secret') !== keys.cron_secret) return json(401, { error: 'unauthorized' });
      return json(200, await runCron(keys));
    }

    if (body.action === 'test') {
      const auth = req.headers.get('Authorization') ?? '';
      const userClient = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await userClient.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
      if (!user) return json(401, { error: 'Πρέπει να συνδεθείς.' });
      const { data: subs } = await admin.from('push_subscriptions').select('*').eq('user_id', user.id);
      if (!subs?.length) return json(404, { error: 'Δεν βρέθηκε συσκευή με ενεργές ειδοποιήσεις.' });
      const results = [];
      for (const sub of subs as Sub[]) {
        results.push(await send(sub, { title: '✅ Οι ειδοποιήσεις δουλεύουν!', body: 'Έτσι θα σου θυμίζουμε τα γεύματα, το νερό και το streak σου.', tag: 'test', url: APP_URL }, keys));
      }
      return json(200, { sent: results.filter((s) => s < 300).length, results });
    }

    return json(400, { error: 'Άγνωστη ενέργεια.' });
  } catch (e) {
    console.error(e);
    return json(500, { error: e instanceof Error ? e.message : 'Σφάλμα server' });
  }
});
