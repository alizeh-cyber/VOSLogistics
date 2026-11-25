-- The referral discount needs BOTH people at 200+ total tasks: the referred person and the referrer.
-- Tasks are counted from uploaded payroll weeks, plus a one-time "already done before payroll" mark per person.

create table public.person_baselines (
  email text primary key check (email = lower(trim(email))),
  prior_tasks int not null default 0 check (prior_tasks >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.person_baselines enable row level security;
create policy "admin manages baselines" on public.person_baselines
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.person_total_tasks(p_email text)
returns int language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(tasks) from public.payroll_entries where email = lower(p_email)), 0)
        + coalesce((select prior_tasks from public.person_baselines where email = lower(p_email)), 0))::int;
$$;
revoke execute on function public.person_total_tasks(text) from public, anon, authenticated;

-- End date of the week in which a person's running total (incl. prior tasks) first reaches 200.
-- Returns '-infinity' if prior tasks alone are 200+, null if not reached yet.
create or replace function public.reached_200_on(p_email text)
returns date language plpgsql stable security definer set search_path = '' as $$
declare
  prior int := coalesce((select prior_tasks from public.person_baselines where email = lower(p_email)), 0);
  d date;
begin
  if prior >= 200 then return '-infinity'::date; end if;
  select w.week_end into d
  from (
    select e.week_start, prior + sum(e.tasks) over (order by e.week_start) as running
    from (select week_start, sum(tasks) as tasks from public.payroll_entries where email = lower(p_email) group by week_start) e
  ) c join public.payroll_weeks w using (week_start)
  where c.running >= 200
  order by c.week_start limit 1;
  return d;
end $$;
revoke execute on function public.reached_200_on(text) from public, anon, authenticated;

create or replace function public.referrals_refresh()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  a date;
  b date;
  qual date;
  changed boolean := false;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  for r in select * from public.referrals where mode = 'tasks' and referred_email is not null loop
    a := public.reached_200_on(r.referred_email);
    b := public.reached_200_on(r.referrer_email);
    qual := case when a is null or b is null then null else greatest(a, b) + 1 end;
    -- If both already had 200+ before payroll, the discount starts the day the referral was added.
    if qual is not null and qual = '-infinity'::date then qual := r.created_at::date; end if;
    if qual is distinct from r.starts_on then
      update public.referrals set starts_on = qual where id = r.id;
      changed := true;
    end if;
  end loop;
  if changed then
    perform public.payroll_recalc(w.week_start) from public.payroll_weeks w;
  end if;
end $$;
revoke execute on function public.referrals_refresh() from public, anon;
grant execute on function public.referrals_refresh() to authenticated;

drop function if exists public.admin_referrals();
create or replace function public.admin_referrals()
returns table (id uuid, referrer_email text, referred_name text, referred_email text, mode text, starts_on date, ends_on date,
               referred_tasks int, referrer_tasks int)
language sql stable security definer set search_path = '' as $$
  select r.id, r.referrer_email, r.referred_name, r.referred_email, r.mode, r.starts_on, r.ends_on,
         case when r.referred_email is null then null else public.person_total_tasks(r.referred_email) end,
         public.person_total_tasks(r.referrer_email)
  from public.referrals r
  where public.is_admin()
  order by coalesce(r.starts_on, '9999-12-31'::date) desc, r.created_at desc;
$$;
revoke execute on function public.admin_referrals() from public, anon;
grant execute on function public.admin_referrals() to authenticated;

-- Total tasks on record for one person (for the referral form).
create or replace function public.admin_person_tasks(p_email text)
returns table (payroll_tasks int, prior_tasks int)
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(tasks) from public.payroll_entries where email = lower(p_email)), 0)::int,
         coalesce((select prior_tasks from public.person_baselines where email = lower(p_email)), 0)
  where public.is_admin();
$$;
revoke execute on function public.admin_person_tasks(text) from public, anon;
grant execute on function public.admin_person_tasks(text) to authenticated;
