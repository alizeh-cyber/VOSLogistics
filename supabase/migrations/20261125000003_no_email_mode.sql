-- No-email mode: Supabase "Confirm email" is turned off, so an email address alone proves nothing.
-- * No automatic approval: the admin approves each new account with one click.
--   On approval, the pay plan from the team list (matched on the login email) is applied automatically.
-- * Admin can set a temporary password for an associate (no reset emails).

drop trigger if exists on_auth_user_z_preapproval on auth.users;
drop trigger if exists roster_invites_apply on public.roster_invites;
drop function if exists public.on_auth_user_preapproval();
drop function if exists public.on_invite_saved();
drop function if exists public.apply_preapproval(uuid);

create or replace function public.associates_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  inv public.roster_invites;
  login_email text;
begin
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  if not public.is_admin() then
    new.status := old.status;
    new.pay_plan := old.pay_plan;
    return new;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    -- First approval: link to the team list and take its pay plan (unless the admin picked one in the same update).
    if new.status = 'approved' and old.status = 'pending' then
      select lower(email) into login_email from auth.users where id = new.user_id;
      select * into inv from public.roster_invites where email = login_email;
      if inv.email is not null then
        if new.pay_plan is not distinct from old.pay_plan then new.pay_plan := inv.pay_plan; end if;
        update public.roster_invites set claimed_by = new.user_id, claimed_at = coalesce(claimed_at, now()) where email = inv.email;
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.associates_guard() from public, anon, authenticated;

-- Admin view of who is waiting, with their team-list match (login email is only visible to the admin here).
create or replace function public.admin_pending_matches()
returns table (user_id uuid, login_email text, on_list boolean, list_name text, list_plan text)
language sql stable security definer set search_path = '' as $$
  select a.user_id, u.email::text, i.email is not null, i.full_name, i.pay_plan
  from public.associates a
  join auth.users u on u.id = a.user_id
  left join public.roster_invites i on i.email = lower(u.email)
  where public.is_admin();
$$;
revoke execute on function public.admin_pending_matches() from public, anon;
grant execute on function public.admin_pending_matches() to authenticated;

-- Admin sets a temporary password for an associate.
create or replace function public.admin_set_password(target uuid, new_password text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if char_length(coalesce(new_password, '')) < 8 then raise exception 'too_short'; end if;
  if not exists (select 1 from public.associates where user_id = target) then raise exception 'not_associate'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = target;
end $$;
revoke execute on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;
