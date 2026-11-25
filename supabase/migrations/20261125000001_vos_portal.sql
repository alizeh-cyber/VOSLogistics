-- VOS Logistics portal: associates, new shift schedule, waivers, job applications, admin.
-- Additive only: the existing public.signups table (old shift page) is not touched.

-- ---------- Admins ----------
create table public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
create policy "admins see themselves" on public.app_admins
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid());
$$;

-- ---------- Settings ----------
create table public.portal_settings (
  id boolean primary key default true check (id),
  schedule_start date not null default '2026-11-30',
  day_cap int not null default 9 check (day_cap > 0),
  updated_at timestamptz not null default now()
);
insert into public.portal_settings default values;
alter table public.portal_settings enable row level security;
create policy "signed-in users read settings" on public.portal_settings
  for select to authenticated using (true);
create policy "admin updates settings" on public.portal_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Associates ----------
create table public.associates (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 80),
  phone text not null default '' check (char_length(phone) <= 30),
  email text not null default '' check (char_length(email) <= 200),
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at timestamptz not null default now(),
  status_changed_at timestamptz
);
alter table public.associates enable row level security;
create policy "see own profile or admin" on public.associates
  for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());
create policy "edit own profile or admin" on public.associates
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

-- Only an admin can change status.
create or replace function public.associates_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  if new.status is distinct from old.status then
    if not public.is_admin() then
      new.status := old.status;
    else
      new.status_changed_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger associates_guard before update on public.associates
  for each row execute function public.associates_guard();

-- New email/password accounts get an associate profile (anonymous users from the old page don't).
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.is_anonymous, false) = false then
    insert into public.associates (user_id, full_name, phone, email)
    values (
      new.id,
      left(coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(coalesce(new.email, 'Associate'), '@', 1)), 80),
      left(coalesce(trim(new.raw_user_meta_data->>'phone'), ''), 30),
      left(coalesce(new.email, ''), 200)
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_user_created_vos after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------- Waivers ----------
create table public.waiver_signatures (
  id uuid primary key,
  signed_at timestamptz not null default now(),
  full_name text not null,
  id_number text not null,
  phone text not null,
  email text not null,
  initials_section3 text not null,
  initials_section4 text not null,
  waiver_version text not null,
  pdf_path text not null,
  user_agent text,
  business_name text,
  user_id uuid references auth.users(id) on delete set null
);
create index waiver_signatures_user_idx on public.waiver_signatures(user_id);
alter table public.waiver_signatures enable row level security;
create policy "public can submit waivers" on public.waiver_signatures
  for insert to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));
create policy "see own waiver or admin" on public.waiver_signatures
  for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());

-- Private storage for signed PDFs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('waivers', 'waivers', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;
create policy "public can upload waiver pdfs" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'waivers');
create policy "admin or owner can read waiver pdfs" on storage.objects
  for select to authenticated using (
    bucket_id = 'waivers' and (
      public.is_admin() or exists (
        select 1 from public.waiver_signatures w
        where w.pdf_path = storage.objects.name and w.user_id = (select auth.uid())
      )
    )
  );

-- ---------- Job applications ----------
create table public.job_applications (
  id uuid primary key default gen_random_uuid(),
  applied_at timestamptz not null default now(),
  full_name text not null,
  phone text not null,
  email text not null,
  days_available text[] not null,
  hours_free text,
  can_do_20_hours boolean,
  max_hours text,
  has_vehicle boolean,
  has_license_insurance boolean not null,
  is_18_plus boolean not null,
  weekly_goal text,
  heard_from text,
  notes text,
  zip_code text,
  hours_per_week text,
  preferred_times text[],
  start_date date,
  consistent_schedule boolean,
  vehicle_type text,
  can_lift_50 boolean,
  experience text[],
  recent_job text,
  work_example text,
  why_interested text,
  interested_in_lead text,
  status text not null default 'new' check (status in ('new','contacted','hired','not_a_fit')),
  status_changed_at timestamptz
);
alter table public.job_applications enable row level security;
create policy "public can apply" on public.job_applications
  for insert to anon, authenticated with check (status = 'new');
create policy "admin reads applications" on public.job_applications
  for select to authenticated using (public.is_admin());
create policy "admin updates applications" on public.job_applications
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin deletes applications" on public.job_applications
  for delete to authenticated using (public.is_admin());

-- ---------- Shift types (the daily shift pattern; editable by admin) ----------
create table public.shift_types (
  code text primary key check (code ~ '^[0-2][0-9][0-5][0-9]$'),
  start_label text not null,
  end_label text not null,
  advanced_seats int not null default 1 check (advanced_seats between 0 and 9),
  beginner_seats int not null default 0 check (beginner_seats between 0 and 9),
  active boolean not null default true
);
insert into public.shift_types (code, start_label, end_label, advanced_seats, beginner_seats) values
  ('0000', '12:00 AM', '4:00 AM', 2, 1),
  ('0400', '4:00 AM', '8:00 AM', 2, 0),
  ('0915', '9:15 AM', '1:15 PM', 1, 0),
  ('1215', '12:15 PM', '4:15 PM', 1, 0),
  ('1915', '7:15 PM', '11:15 PM', 2, 1);
alter table public.shift_types enable row level security;
create policy "signed-in users read shift types" on public.shift_types
  for select to authenticated using (true);
create policy "admin manages shift types" on public.shift_types
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Helpers ----------
create or replace function public.can_book()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.associates a
    where a.user_id = auth.uid() and a.status = 'approved'
  ) and exists (
    select 1 from public.waiver_signatures w where w.user_id = auth.uid()
  );
$$;

-- ---------- New shift sign-ups ----------
-- slot_id format matches the old page: YYYY-MM-DD-HHMM plus '' / -2 / -3 (advanced seats) or -t / -t2 (beginner seats)
create table public.shift_signups (
  slot_id text primary key check (slot_id ~ '^\d{4}-\d{2}-\d{2}-\d{4}(-([2-9]|t[2-9]?))?$'),
  user_id uuid not null default auth.uid() references public.associates(user_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index shift_signups_user_idx on public.shift_signups(user_id);
alter table public.shift_signups enable row level security;
create policy "approved associates and admin read schedule" on public.shift_signups
  for select to authenticated using (public.can_book() or public.is_admin());
create policy "book yourself" on public.shift_signups
  for insert to authenticated with check (user_id = (select auth.uid()) and public.can_book());
create policy "cancel your own or admin removes" on public.shift_signups
  for delete to authenticated using (user_id = (select auth.uid()) or public.is_admin());

create or replace function public.shift_signups_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  d date := left(new.slot_id, 10)::date;
  c text := substr(new.slot_id, 12, 4);
  suf text := substr(new.slot_id, 16);
  st public.shift_types;
  s public.portal_settings;
  n int;
begin
  select * into s from public.portal_settings limit 1;
  select * into st from public.shift_types where code = c and active;
  if st.code is null then raise exception 'bad_slot'; end if;
  if suf = '' then n := 1;
  elsif suf ~ '^-[2-9]$' then n := substr(suf, 2)::int;
  else n := null; end if;
  if n is not null and n > st.advanced_seats then raise exception 'bad_slot'; end if;
  if suf like '-t%' then
    n := coalesce(nullif(substr(suf, 3), '')::int, 1);
    if n > st.beginner_seats then raise exception 'bad_slot'; end if;
  end if;
  if d < s.schedule_start then raise exception 'not_open'; end if;
  if ((d + c::time) at time zone 'America/Chicago') < now() then raise exception 'past'; end if;
  perform pg_advisory_xact_lock(hashtext('shift_' || left(new.slot_id, 10)));
  if (select count(*) from public.shift_signups where left(slot_id, 10) = left(new.slot_id, 10)) >= s.day_cap then
    raise exception 'day_full';
  end if;
  new.created_at := now();
  return new;
end $$;
create trigger shift_signups_check before insert on public.shift_signups
  for each row execute function public.shift_signups_check();

-- Schedule with names (only for approved associates who signed, or admin).
create or replace function public.schedule_between(d1 date, d2 date)
returns table (slot_id text, user_id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select s.slot_id, s.user_id, a.full_name
  from public.shift_signups s join public.associates a on a.user_id = s.user_id
  where (public.can_book() or public.is_admin())
    and left(s.slot_id, 10)::date between d1 and d2
  order by s.slot_id;
$$;

-- Live updates for the schedule.
alter publication supabase_realtime add table public.shift_signups;

-- Lock helper functions down to signed-in users.
revoke execute on function public.schedule_between(date, date) from public, anon;
grant execute on function public.schedule_between(date, date) to authenticated;
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
revoke execute on function public.shift_signups_check() from public, anon, authenticated;
revoke execute on function public.associates_guard() from public, anon, authenticated;

-- ---------- Tightening (applied as vos_portal_tighten) ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false
     and exists (select 1 from public.app_admins a where a.user_id = auth.uid());
$$;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.can_book() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.can_book() to authenticated;

-- ---------- Admin cleanup rights (applied as vos_admin_can_delete_waiver_pdfs) ----------
create policy "admin can delete waiver pdfs" on storage.objects
  for delete to authenticated using (bucket_id = 'waivers' and public.is_admin());
create policy "admin deletes waivers" on public.waiver_signatures
  for delete to authenticated using (public.is_admin());
