-- Pay plans per associate, pre-approved team list (auto-approval after email confirmation),
-- and the pay plan recorded on each signed agreement.

-- ---------- Pay plans ----------
create table public.pay_plans (
  code text primary key,
  label text not null,
  kind text not null check (kind in ('scale','flat')),
  tiers jsonb not null,            -- [{"label": "Under 200", "fee": 1.00}, ...]
  sort int not null default 0
);
insert into public.pay_plans (code, label, kind, tiers, sort) values
  ('scale_100', 'Pay scale A (starts at $1.00)', 'scale', '[{"label":"Under 200","fee":1.00},{"label":"200 to 399","fee":0.80},{"label":"400 or more","fee":0.60}]', 1),
  ('scale_080', 'Pay scale B (starts at $0.80)', 'scale', '[{"label":"Under 200","fee":0.80},{"label":"200 to 399","fee":0.60},{"label":"400 or more","fee":0.40}]', 2),
  ('flat_030',  'Flat $0.30 per task', 'flat', '[{"label":"Every Task","fee":0.30}]', 3),
  ('flat_010',  'Flat $0.10 per task', 'flat', '[{"label":"Every Task","fee":0.10}]', 4);
alter table public.pay_plans enable row level security;

alter table public.associates add column pay_plan text not null default 'scale_100' references public.pay_plans(code);

create policy "read own plan or admin" on public.pay_plans
  for select to authenticated using (
    public.is_admin() or exists (select 1 from public.associates a where a.user_id = (select auth.uid()) and a.pay_plan = pay_plans.code)
  );
create policy "admin manages plans" on public.pay_plans
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Pre-approved team list ----------
create table public.roster_invites (
  email text primary key check (email = lower(trim(email)) and email like '%@%'),
  full_name text not null,
  phone text not null default '',
  pay_plan text not null default 'scale_100' references public.pay_plans(code),
  created_at timestamptz not null default now(),
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz
);
alter table public.roster_invites enable row level security;
create policy "admin manages pre-approved list" on public.roster_invites
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Status and pay plan can only be changed by an admin (or by the system auto-approval below).
create or replace function public.associates_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  trusted boolean := public.is_admin() or coalesce(current_setting('vos.system', true), '') = 'on';
begin
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  if not trusted then
    new.status := old.status;
    new.pay_plan := old.pay_plan;
  elsif new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end $$;

-- Approve a confirmed account whose email is on the pre-approved list.
create or replace function public.apply_preapproval(uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  u auth.users;
  inv public.roster_invites;
begin
  select * into u from auth.users where id = uid;
  if u.id is null or u.email_confirmed_at is null or coalesce(u.is_anonymous, false) then return; end if;
  select * into inv from public.roster_invites where email = lower(u.email);
  if inv.email is null then return; end if;
  perform set_config('vos.system', 'on', true);
  update public.associates
     set status = case when status = 'pending' then 'approved' else status end,
         pay_plan = inv.pay_plan
   where user_id = uid;
  perform set_config('vos.system', '', true);
  update public.roster_invites set claimed_by = uid, claimed_at = coalesce(claimed_at, now()) where email = inv.email;
end $$;
revoke execute on function public.apply_preapproval(uuid) from public, anon, authenticated;

create or replace function public.on_auth_user_preapproval()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and (tg_op = 'INSERT' or old.email_confirmed_at is null or old.email is distinct from new.email) then
    perform public.apply_preapproval(new.id);
  end if;
  return new;
end $$;
revoke execute on function public.on_auth_user_preapproval() from public, anon, authenticated;
-- Runs after on_auth_user_created_vos (triggers fire in name order).
create trigger on_auth_user_z_preapproval after insert or update of email_confirmed_at, email on auth.users
  for each row execute function public.on_auth_user_preapproval();

-- Adding someone to the list later approves them if they already have a confirmed account.
create or replace function public.on_invite_saved()
returns trigger language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = new.email and email_confirmed_at is not null and not coalesce(is_anonymous, false);
  if uid is not null then perform public.apply_preapproval(uid); end if;
  return new;
end $$;
revoke execute on function public.on_invite_saved() from public, anon, authenticated;
create trigger roster_invites_apply after insert or update of pay_plan on public.roster_invites
  for each row execute function public.on_invite_saved();

-- ---------- Agreements record the signer's pay plan ----------
alter table public.waiver_signatures add column pay_plan text references public.pay_plans(code);

-- Signing now requires a portal account; the pay plan is taken from the account, not from the browser.
drop policy "public can submit waivers" on public.waiver_signatures;
create policy "associates submit their own agreement" on public.waiver_signatures
  for insert to authenticated
  with check (user_id = (select auth.uid()) and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false);

create or replace function public.waiver_set_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is not null then
    select a.pay_plan into new.pay_plan from public.associates a where a.user_id = new.user_id;
  end if;
  new.signed_at := now();
  return new;
end $$;
revoke execute on function public.waiver_set_plan() from public, anon, authenticated;
create trigger waiver_set_plan before insert on public.waiver_signatures
  for each row execute function public.waiver_set_plan();

drop policy "public can upload waiver pdfs" on storage.objects;
create policy "associates upload waiver pdfs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'waivers' and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false);
