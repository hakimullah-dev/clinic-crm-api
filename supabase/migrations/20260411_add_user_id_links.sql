alter table public.doctors
  add column if not exists user_id uuid references auth.users (id) on delete set null;

alter table public.patients
  add column if not exists user_id uuid references auth.users (id) on delete set null;

create unique index if not exists doctors_user_id_unique_idx
  on public.doctors (user_id)
  where user_id is not null;

create unique index if not exists patients_user_id_unique_idx
  on public.patients (user_id)
  where user_id is not null;

-- ============================================
-- LEGACY BACKFILL — RUN ONCE ON FIRST MIGRATION
-- Safe to skip if no pre-existing rows exist.
-- All new rows use user_id directly.
-- Remove this block after first production run.
-- ============================================
update public.doctors as d
set user_id = u.id
from auth.users as u
where d.user_id is null
  and d.email is not null
  and lower(u.email) = lower(d.email);

-- ============================================
-- LEGACY BACKFILL — RUN ONCE ON FIRST MIGRATION
-- Safe to skip if no pre-existing rows exist.
-- All new rows use user_id directly.
-- Remove this block after first production run.
-- ============================================
update public.patients as p
set user_id = u.id
from auth.users as u
where p.user_id is null
  and p.email is not null
  and lower(u.email) = lower(p.email);
