-- Referral discounts start automatically once the referred person reaches 200 total tasks
-- (counted from uploaded Lime payroll weeks). The discount starts the Monday after that week
-- and lasts 3 months. Referrals entered with a known start date ("manual") keep that date.

alter table public.referrals add column referred_email text check (referred_email is null or referred_email = lower(trim(referred_email)));
alter table public.referrals add column mode text not null default 'manual' check (mode in ('manual','tasks'));
alter table public.referrals alter column starts_on drop not null;
alter table public.referrals alter column ends_on drop not null;

create or replace function public.referrals_set_end()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.referrer_email := lower(trim(new.referrer_email));
  new.referred_email := nullif(lower(trim(coalesce(new.referred_email, ''))), '');
  if new.mode = 'manual' and new.starts_on is null then raise exception 'start_date_required'; end if;
  new.ends_on := case when new.starts_on is null then null else (new.starts_on + interval '3 months')::date end;
  return new;
end $$;

-- Tasks a person has done in total (all uploaded weeks).
create or replace function public.person_total_tasks(p_email text)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(sum(tasks), 0)::int from public.payroll_entries where email = lower(p_email);
$$;
revoke execute on function public.person_total_tasks(text) from public, anon, authenticated;

-- Work out start dates for "tasks" referrals, then recalculate rent for every week if anything changed.
create or replace function public.referrals_refresh()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  qual date;
  changed boolean := false;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  for r in select * from public.referrals where mode = 'tasks' and referred_email is not null loop
    qual := null;
    select w.week_end + 1 into qual
    from (
      select e.week_start, sum(e.tasks) over (order by e.week_start) as running
      from (select week_start, sum(tasks) as tasks from public.payroll_entries where email = r.referred_email group by week_start) e
    ) c join public.payroll_weeks w using (week_start)
    where c.running >= 200
    order by c.week_start limit 1;
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

-- Referral list for the admin, with the referred person's task progress.
create or replace function public.admin_referrals()
returns table (id uuid, referrer_email text, referred_name text, referred_email text, mode text, starts_on date, ends_on date, referred_tasks int)
language sql stable security definer set search_path = '' as $$
  select r.id, r.referrer_email, r.referred_name, r.referred_email, r.mode, r.starts_on, r.ends_on,
         case when r.referred_email is null then null else public.person_total_tasks(r.referred_email) end
  from public.referrals r
  where public.is_admin()
  order by coalesce(r.starts_on, '9999-12-31'::date) desc, r.created_at desc;
$$;
revoke execute on function public.admin_referrals() from public, anon;
grant execute on function public.admin_referrals() to authenticated;

-- Re-check referrals at the end of every upload (the app also calls referrals_refresh after deleting a week).
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

  perform public.referrals_refresh();

  return query select e.lime_name, e.email, e.tasks, e.fee_per_task, e.actual_pay
    from public.payroll_entries e where e.week_start = p_start order by e.lime_name;
end $$;
revoke execute on function public.payroll_import(date, date, jsonb, text, int, numeric) from public, anon;
grant execute on function public.payroll_import(date, date, jsonb, text, int, numeric) to authenticated;

-- Existing referrals already qualified: record who was referred.
update public.referrals set referred_email = 'braydenthornton08@gmail.com' where referred_name = 'Brayden Thornton' and referred_email is null;
update public.referrals set referred_email = 'samorse34@icloud.com' where referred_name = 'Sam Morse' and referred_email is null;
update public.referrals set referred_email = 'titoruetz@gmail.com' where referred_name = 'Tito Ruetz' and referred_email is null;
