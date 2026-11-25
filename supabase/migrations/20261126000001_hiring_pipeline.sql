-- Hiring pipeline: applicant stages from first contact to training, next steps, notes timeline,
-- and an automatic onboarding checklist (team list, portal account, agreement, first shift, first tasks).

alter table public.job_applications drop constraint if exists job_applications_status_check;
alter table public.job_applications add constraint job_applications_status_check check (status in (
  'new','contacted','interview_scheduled','interviewed','hired','onboarding','training_scheduled','trained','active',
  'no_response','not_a_fit','withdrew'));
alter table public.job_applications add column next_step text;
alter table public.job_applications add column next_step_at timestamptz;

create table public.application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_applications(id) on delete cascade,
  at timestamptz not null default now(),
  by_user uuid default auth.uid(),
  by_name text,
  kind text not null check (kind in ('applied','stage','note','next_step')),
  stage text,
  note text
);
create index application_events_app_idx on public.application_events(application_id, at);
alter table public.application_events enable row level security;
create policy "admin reads application events" on public.application_events
  for select to authenticated using (public.is_admin());
create policy "admin adds notes" on public.application_events
  for insert to authenticated with check (public.is_admin() and kind = 'note');
create policy "admin deletes own notes" on public.application_events
  for delete to authenticated using (public.is_admin() and kind = 'note' and by_user = (select auth.uid()));

-- Fill in who made a change (name from their associate profile, else their email).
create or replace function public.application_events_fill()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.by_user is not null and new.by_name is null then
    select coalesce((select a.full_name from public.associates a where a.user_id = new.by_user), (select u.email from auth.users u where u.id = new.by_user))
      into new.by_name;
  end if;
  new.at := now();
  return new;
end $$;
revoke execute on function public.application_events_fill() from public, anon, authenticated;
create trigger application_events_fill before insert on public.application_events
  for each row execute function public.application_events_fill();

-- Log applications and stage / next-step changes automatically.
create or replace function public.job_applications_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_events (application_id, kind, stage, by_user, by_name) values (new.id, 'applied', new.status, null, 'Job page');
  else
    if new.status is distinct from old.status then
      insert into public.application_events (application_id, kind, stage) values (new.id, 'stage', new.status);
    end if;
    if new.next_step is distinct from old.next_step or new.next_step_at is distinct from old.next_step_at then
      insert into public.application_events (application_id, kind, note)
      values (new.id, 'next_step', case when new.next_step is null and new.next_step_at is null then 'Next step cleared'
        else coalesce(new.next_step, 'Next step') || coalesce(' · ' || to_char(new.next_step_at at time zone 'America/Chicago', 'Dy Mon FMDD, FMHH12:MI AM'), '') end);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.job_applications_log() from public, anon, authenticated;
create trigger job_applications_log after insert or update on public.job_applications
  for each row execute function public.job_applications_log();

-- Onboarding checklist per applicant, matched by email (team list, portal login, or contact email).
create or replace function public.admin_applicant_progress()
returns table (application_id uuid, on_team_list boolean, team_plan text, has_account boolean, agreement_signed boolean,
               shifts_booked int, tasks_done int)
language sql stable security definer set search_path = '' as $$
  with apps as (select j.id, lower(trim(j.email)) as em from public.job_applications j),
  acct as (
    select ap.id as app_id, a.user_id
    from apps ap
    join public.associates a on lower(a.email) = ap.em
       or a.user_id = (select u.id from auth.users u where lower(u.email) = ap.em limit 1)
       or a.user_id = (select i.claimed_by from public.roster_invites i where i.email = ap.em)
  )
  select ap.id,
    exists (select 1 from public.roster_invites i where i.email = ap.em),
    (select i.pay_plan from public.roster_invites i where i.email = ap.em),
    exists (select 1 from acct where acct.app_id = ap.id),
    exists (select 1 from acct join public.waiver_signatures w on w.user_id = acct.user_id where acct.app_id = ap.id),
    (select count(*)::int from acct join public.shift_signups s on s.user_id = acct.user_id where acct.app_id = ap.id),
    (select coalesce(sum(e.tasks), 0)::int from public.payroll_entries e where e.email = ap.em
       or e.email in (select lower(u.email) from acct join auth.users u on u.id = acct.user_id where acct.app_id = ap.id))
  from apps ap
  where public.is_admin();
$$;
revoke execute on function public.admin_applicant_progress() from public, anon;
grant execute on function public.admin_applicant_progress() to authenticated;

-- ---------- Next step type: interview / training / follow-up (applied as hiring_next_step_type) ----------
alter table public.job_applications add column next_step_type text check (next_step_type in ('interview','training','follow_up'));
-- job_applications_log() now prefixes "Interview:" / "Training:" in the history (see live function).
