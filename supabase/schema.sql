-- NutriLog: σχήμα βάσης για το Supabase.
-- Τρέξ' το μία φορά στο Supabase → SQL Editor → New query → Run.

-- Τα δεδομένα κάθε χρήστη (στόχοι, καταγραφές, τρόφιμα) ως ένα JSON έγγραφο.
create table if not exists public.user_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- Κάθε χρήστης βλέπει και αλλάζει ΜΟΝΟ τα δικά του δεδομένα.
drop policy if exists "user_data select own" on public.user_data;
drop policy if exists "user_data insert own" on public.user_data;
drop policy if exists "user_data update own" on public.user_data;
drop policy if exists "user_data delete own" on public.user_data;
create policy "user_data select own" on public.user_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "user_data insert own" on public.user_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "user_data update own" on public.user_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "user_data delete own" on public.user_data for delete to authenticated using ((select auth.uid()) = user_id);

-- Μετρητής χρήσης AI ανά χρήστη και ημέρα (για το ημερήσιο όριο).
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- RLS χωρίς policies: κανείς δεν διαβάζει/γράφει τον πίνακα απευθείας,
-- μόνο μέσω της παρακάτω συνάρτησης.
alter table public.ai_usage enable row level security;

-- Λογαριασμοί χωρίς ημερήσιο όριο AI (π.χ. ο διαχειριστής). RLS χωρίς policies:
-- η εφαρμογή δεν τον βλέπει. Προσθήκη email από το SQL Editor:
--   insert into public.ai_unlimited (email) values ('someone@example.com');
create table if not exists public.ai_unlimited (
  email    text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
alter table public.ai_unlimited enable row level security;

-- Αυξάνει τον μετρητή του συνδεδεμένου χρήστη. Επιστρέφει τον νέο αριθμό,
-- ή -1 αν ξεπεράστηκε το όριο (εκτός αν ο χρήστης είναι στο ai_unlimited).
create or replace function public.bump_ai_usage(p_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  c         int;
  unlimited boolean;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  insert into public.ai_usage as u (user_id, day, count)
  values (uid, current_date, 1)
  on conflict (user_id, day) do update set count = u.count + 1
  returning u.count into c;
  select exists (
    select 1 from auth.users au
    join public.ai_unlimited x on x.email = lower(au.email)
    where au.id = uid
  ) into unlimited;
  if c > p_limit and not unlimited then
    return -1;
  end if;
  return c;
end;
$$;

revoke all on function public.bump_ai_usage(int) from public, anon;
grant execute on function public.bump_ai_usage(int) to authenticated;

-- ---------------------------------------------------------------------------
-- Υπενθυμίσεις (Web Push)
-- ---------------------------------------------------------------------------

-- Μία γραμμή ανά συσκευή με ενεργές ειδοποιήσεις, μαζί με τις ρυθμίσεις του χρήστη.
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  tz         text not null default 'Europe/Athens',
  prefs      jsonb not null default '{}'::jsonb,
  last_sent  jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists "push select own" on public.push_subscriptions;
drop policy if exists "push insert own" on public.push_subscriptions;
drop policy if exists "push update own" on public.push_subscriptions;
drop policy if exists "push delete own" on public.push_subscriptions;
create policy "push select own" on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "push insert own" on public.push_subscriptions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "push update own" on public.push_subscriptions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "push delete own" on public.push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);

-- Μυστικά του server. Μόνο ο service role (οι Edge Functions) τα διαβάζει.
-- Συμπλήρωση (ΠΟΤΕ στο repository):
--   insert into public.app_secrets(name,value) values
--     ('vapid_public','...'),('vapid_private','...'),('cron_secret','...');
-- Τα VAPID κλειδιά βγαίνουν με: npx web-push generate-vapid-keys
-- Το vapid_public μπαίνει και στο index.html (VAPID_PUBLIC).
create table if not exists public.app_secrets (
  name  text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on table public.app_secrets from anon, authenticated;

-- Κάθε 15 λεπτά καλείται η function "reminders".
create schema if not exists extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select cron.schedule('nutrilog-reminders', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://ekydgjaqwvylmfcmkzfp.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from public.app_secrets where name='cron_secret')),
    body := '{"action":"cron"}'::jsonb,
    timeout_milliseconds := 30000)
$job$);
