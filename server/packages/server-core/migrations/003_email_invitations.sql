alter table orka.invites add column if not exists email text;
create table if not exists orka.invitation_deliveries(
  token_hash text primary key,
  project_id uuid not null references orka.projects on delete cascade,
  email_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists invite_email_cooldown on orka.invitation_deliveries(project_id,created_at);
