-- New sign-ups are approved automatically (setting can be turned off in admin):
-- people on the team list get their listed pay plan, everyone else gets Scale A.
alter table public.portal_settings add column auto_approve boolean not null default true;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  inv public.roster_invites;
  auto boolean;
begin
  if coalesce(new.is_anonymous, false) then return new; end if;
  select coalesce((select auto_approve from public.portal_settings limit 1), false) into auto;
  select * into inv from public.roster_invites where email = lower(new.email);
  insert into public.associates (user_id, full_name, phone, email, status, pay_plan, status_changed_at)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(coalesce(new.email, 'Associate'), '@', 1)), 80),
    left(coalesce(trim(new.raw_user_meta_data->>'phone'), ''), 30),
    left(coalesce(new.email, ''), 200),
    case when auto then 'approved' else 'pending' end,
    coalesce(inv.pay_plan, 'scale_100'),
    case when auto then now() end
  )
  on conflict (user_id) do nothing;
  if auto and inv.email is not null then
    update public.roster_invites set claimed_by = new.id, claimed_at = coalesce(claimed_at, now()) where email = inv.email;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
