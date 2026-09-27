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

-- Αυξάνει τον μετρητή του συνδεδεμένου χρήστη. Επιστρέφει τον νέο αριθμό,
-- ή -1 αν ξεπεράστηκε το όριο.
create or replace function public.bump_ai_usage(p_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  c   int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  insert into public.ai_usage as u (user_id, day, count)
  values (uid, current_date, 1)
  on conflict (user_id, day) do update set count = u.count + 1
  returning u.count into c;
  if c > p_limit then
    return -1;
  end if;
  return c;
end;
$$;

revoke all on function public.bump_ai_usage(int) from public, anon;
grant execute on function public.bump_ai_usage(int) to authenticated;
