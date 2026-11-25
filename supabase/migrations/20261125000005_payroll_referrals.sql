-- Payroll from Lime weekly reports, referral discounts, associate earnings.
-- People are identified by email: their team-list email, or their portal login email.

-- Manager plan (no fee)
insert into public.pay_plans (code, label, kind, tiers, sort)
values ('none', 'No fee (manager)', 'flat', '[{"label":"Every Task","fee":0}]', 0)
on conflict (code) do nothing;

-- ---------- People (team list + portal accounts) ----------
create or replace function public.person_plan(p_email text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select a.pay_plan from public.associates a join auth.users u on u.id = a.user_id where lower(u.email) = lower(p_email) limit 1),
    (select a.pay_plan from public.associates a join public.roster_invites i on i.claimed_by = a.user_id where i.email = lower(p_email) limit 1),
    (select pay_plan from public.roster_invites where email = lower(p_email)),
    'scale_100');
$$;
revoke execute on function public.person_plan(text) from public, anon, authenticated;

-- ---------- Referrals ----------
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_email text not null check (referrer_email = lower(trim(referrer_email))),
  referred_name text not null,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create or replace function public.referrals_set_end()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.referrer_email := lower(trim(new.referrer_email));
  new.ends_on := (new.starts_on + interval '3 months')::date;
  return new;
end $$;
revoke execute on function public.referrals_set_end() from public, anon, authenticated;
create trigger referrals_set_end before insert or update on public.referrals
  for each row execute function public.referrals_set_end();
alter table public.referrals enable row level security;
create policy "admin manages referrals" on public.referrals
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.active_referrals(p_email text, p_on date)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.referrals
  where referrer_email = lower(p_email) and starts_on <= p_on and ends_on > p_on;
$$;
revoke execute on function public.active_referrals(text, date) from public, anon, authenticated;

-- Fee per task for a person, a task count and a week.
create or replace function public.fee_for(p_email text, p_tasks int, p_on date)
returns table (plan text, referrals int, base_fee numeric, fee numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  pl public.pay_plans;
  t jsonb;
  b numeric;
  n int;
begin
  select * into pl from public.pay_plans where code = public.person_plan(p_email);
  if pl.kind = 'flat' then
    b := (pl.tiers->0->>'fee')::numeric;
  else
    -- tiers are "Under 200", "200 to 399", "400 or more" (in order); pick by weekly task count
    b := (pl.tiers->0->>'fee')::numeric;
    for t in select * from jsonb_array_elements(pl.tiers) loop
      if (t->>'label') ~ '^\d+' and p_tasks >= substring(t->>'label' from '^(\d+)')::int then
        b := (t->>'fee')::numeric;
      end if;
    end loop;
  end if;
  n := public.active_referrals(p_email, p_on);
  return query select pl.code, n, b, greatest(0, b - 0.05 * n);
end $$;
revoke execute on function public.fee_for(text, int, date) from public, anon, authenticated;

-- ---------- Payroll ----------
create table public.lime_names (
  lime_name text primary key,
  email text not null check (email = lower(trim(email))),
  updated_at timestamptz not null default now()
);
alter table public.lime_names enable row level security;
create policy "admin manages lime names" on public.lime_names
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table public.payroll_weeks (
  week_start date primary key,
  week_end date not null,
  lime_tasks int,
  lime_fee numeric(12,2),
  source_file text,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid default auth.uid()
);
alter table public.payroll_weeks enable row level security;
create policy "admin manages payroll weeks" on public.payroll_weeks
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table public.payroll_entries (
  week_start date not null references public.payroll_weeks(week_start) on delete cascade,
  lime_name text not null,
  email text not null,
  tasks int not null check (tasks >= 0),
  gross numeric(12,2) not null,
  plan text,
  referrals int not null default 0,
  fee_per_task numeric(6,2) not null,
  fee_override boolean not null default false,
  bonus numeric(12,2) not null default 0,
  note text,
  rent_total numeric(12,2) generated always as (round(tasks * fee_per_task, 2)) stored,
  actual_pay numeric(12,2) generated always as (gross - round(tasks * fee_per_task, 2) + bonus) stored,
  updated_at timestamptz not null default now(),
  primary key (week_start, lime_name)
);
create index payroll_entries_email_idx on public.payroll_entries(email);
alter table public.payroll_entries enable row level security;
create policy "admin manages payroll entries" on public.payroll_entries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Import (or re-import) one Lime weekly report. Keeps bonuses and manual rent overrides on re-import.
create or replace function public.payroll_import(p_start date, p_end date, p_rows jsonb, p_file text, p_lime_tasks int, p_lime_fee numeric)
returns table (lime_name text, email text, tasks int, fee_per_task numeric, actual_pay numeric)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r jsonb;
  em text;
  missing text[] := '{}';
  f record;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if not exists (select 1 from public.lime_names l where l.lime_name = r->>'limeName') then
      missing := missing || (r->>'limeName');
    end if;
  end loop;
  if array_length(missing, 1) > 0 then raise exception 'unmapped:%', array_to_string(missing, '|'); end if;

  insert into public.payroll_weeks (week_start, week_end, lime_tasks, lime_fee, source_file)
  values (p_start, p_end, p_lime_tasks, p_lime_fee, p_file)
  on conflict (week_start) do update set week_end = excluded.week_end, lime_tasks = excluded.lime_tasks,
    lime_fee = excluded.lime_fee, source_file = excluded.source_file, uploaded_at = now(), uploaded_by = auth.uid();

  -- People no longer in the report for this week are removed.
  delete from public.payroll_entries e where e.week_start = p_start
    and e.lime_name not in (select x->>'limeName' from jsonb_array_elements(p_rows) x);

  for r in select * from jsonb_array_elements(p_rows) loop
    select l.email into em from public.lime_names l where l.lime_name = r->>'limeName';
    select * into f from public.fee_for(em, (r->>'tasks')::int, p_start);
    insert into public.payroll_entries as e (week_start, lime_name, email, tasks, gross, plan, referrals, fee_per_task)
    values (p_start, r->>'limeName', em, (r->>'tasks')::int, (r->>'gross')::numeric, f.plan, f.referrals, f.fee)
    on conflict (week_start, lime_name) do update set
      email = excluded.email, tasks = excluded.tasks, gross = excluded.gross, plan = excluded.plan, referrals = excluded.referrals,
      fee_per_task = case when e.fee_override then e.fee_per_task else excluded.fee_per_task end,
      updated_at = now();
  end loop;

  return query select e.lime_name, e.email, e.tasks, e.fee_per_task, e.actual_pay
    from public.payroll_entries e where e.week_start = p_start order by e.lime_name;
end $$;
revoke execute on function public.payroll_import(date, date, jsonb, text, int, numeric) from public, anon;
grant execute on function public.payroll_import(date, date, jsonb, text, int, numeric) to authenticated;

-- Recalculate rent for a week (e.g. after adding a referral). Manual overrides are kept.
create or replace function public.payroll_recalc(p_start date)
returns void language plpgsql security definer set search_path = '' as $$
declare e record; f record;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  for e in select * from public.payroll_entries where week_start = p_start and not fee_override loop
    select * into f from public.fee_for(e.email, e.tasks, p_start);
    update public.payroll_entries set plan = f.plan, referrals = f.referrals, fee_per_task = f.fee, updated_at = now()
      where week_start = p_start and lime_name = e.lime_name;
  end loop;
end $$;
revoke execute on function public.payroll_recalc(date) from public, anon;
grant execute on function public.payroll_recalc(date) to authenticated;

-- Everyone the admin can pick from: team list + portal accounts, with current plan and active referrals.
create or replace function public.admin_people()
returns table (email text, full_name text, plan text, has_account boolean, referrals int, fee_now numeric)
language sql stable security definer set search_path = '' as $$
  with p as (
    select i.email, i.full_name, (i.claimed_by is not null) as has_account from public.roster_invites i
    union
    select lower(u.email), a.full_name, true from public.associates a join auth.users u on u.id = a.user_id
    where lower(u.email) not in (select email from public.roster_invites where claimed_by is not null)
      and not exists (select 1 from public.app_admins ad where ad.user_id = a.user_id and a.status = 'pending')
  )
  select p.email, p.full_name, f.plan, bool_or(p.has_account), f.referrals, f.fee
  from p cross join lateral public.fee_for(p.email, 0, current_date) f
  where public.is_admin()
  group by p.email, p.full_name, f.plan, f.referrals, f.fee
  order by p.full_name;
$$;
revoke execute on function public.admin_people() from public, anon;
grant execute on function public.admin_people() to authenticated;

-- An associate's own earnings: only week, tasks and actual pay.
create or replace function public.my_earnings()
returns table (week_start date, week_end date, tasks int, actual_pay numeric)
language sql stable security definer set search_path = '' as $$
  select w.week_start, w.week_end, sum(e.tasks)::int, sum(e.actual_pay)
  from public.payroll_entries e join public.payroll_weeks w using (week_start)
  where auth.uid() is not null
    and e.email in (
      select lower(u.email) from auth.users u where u.id = auth.uid()
      union select i.email from public.roster_invites i where i.claimed_by = auth.uid()
    )
  group by w.week_start, w.week_end
  order by w.week_start desc;
$$;
revoke execute on function public.my_earnings() from public, anon;
grant execute on function public.my_earnings() to authenticated;

-- Admins can make another account an admin (or remove it). Can't remove yourself.
create or replace function public.admin_set_admin(target uuid, make boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if make then
    insert into public.app_admins (user_id) values (target) on conflict do nothing;
  else
    if target = auth.uid() then raise exception 'cannot_remove_self'; end if;
    delete from public.app_admins where user_id = target;
  end if;
end $$;
revoke execute on function public.admin_set_admin(uuid, boolean) from public, anon;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;

-- Admins can see who the admins are (to show badges in the roster).
drop policy if exists "admins see themselves" on public.app_admins;
create policy "admins see admins" on public.app_admins
  for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());
