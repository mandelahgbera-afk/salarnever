-- ============================================================
-- Salarn — Supabase Patch
-- Run this in Supabase SQL Editor → New Query → Run
-- ============================================================

-- ── 1. Auto-create user profile + balance row on every signup ──
-- Runs server-side (security definer), bypasses RLS entirely.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (auth_id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', null),
    'user'
  )
  on conflict (auth_id) do nothing;

  insert into public.user_balances (user_email, balance_usd, total_invested, total_profit_loss)
  values (new.email, 0, 0, 0)
  on conflict (user_email) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 2. Backfill existing auth users who have no profile row ──
insert into public.users (auth_id, email, full_name, role)
select
  au.id,
  au.email,
  au.raw_user_meta_data->>'full_name',
  'user'
from auth.users au
left join public.users pu on pu.auth_id = au.id
where pu.id is null
on conflict (auth_id) do nothing;

insert into public.user_balances (user_email, balance_usd, total_invested, total_profit_loss)
select u.email, 0, 0, 0
from public.users u
left join public.user_balances ub on ub.user_email = u.email
where ub.id is null
on conflict (user_email) do nothing;

-- ── 3. Grant super-admin role ──
-- Replace 'you@example.com' with the actual admin email, then run:
--
--   UPDATE public.users
--   SET role = 'admin'
--   WHERE email = 'you@example.com';
--
-- After running this, sign out of the app and sign back in.
-- You will be redirected to the Admin Dashboard automatically.
--
-- To verify it worked:
--   SELECT email, role FROM public.users WHERE email = 'you@example.com';

-- ── 4. Verify the trigger is active ──
-- SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'on_auth_user_created';
-- Should return 1 row with tgenabled = 'O' (enabled)
