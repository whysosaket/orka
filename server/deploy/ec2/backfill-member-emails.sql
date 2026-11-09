-- Operator-only backfill after migration 011. The API role keeps no auth access.
-- Use the account email, never user-editable metadata. Repeating this is safe:
-- authenticated requests continue to refresh populated identities normally.
begin;
insert into orka.env_profiles(user_id, label, email)
select u.id,
       coalesce(nullif(p.display_name, ''), 'Member ' || left(u.id::text, 8)),
       nullif(btrim(u.email), '')
from auth.users u
left join orka.profiles p on p.user_id = u.id
where exists (select 1 from orka.members m where m.user_id = u.id)
on conflict (user_id) do update set email = excluded.email
where orka.env_profiles.email is null;
commit;

-- Counts only: do not write member emails or account identifiers to deploy logs.
select count(*) as project_members,
       count(p.email) as members_with_email,
       count(*) filter (where p.email is null) as members_without_email
from (select distinct user_id from orka.members) m
left join orka.env_profiles p on p.user_id = m.user_id;
