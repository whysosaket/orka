create table if not exists orka.github_connections(
  user_id uuid primary key,
  github_id text not null,
  login text not null,
  credentials text not null,
  expires_at timestamptz not null
);
create table if not exists orka.github_authorizations(
  id uuid primary key,
  user_id uuid not null,
  device_code text not null,
  expires_at timestamptz not null,
  next_poll_at timestamptz not null,
  poll_interval integer not null check(poll_interval>=5)
);
create index if not exists github_authorizations_user on orka.github_authorizations(user_id);
create table if not exists orka.source_repositories(
  project_id uuid not null,
  source_id uuid not null,
  repository jsonb not null,
  revision bigint not null default 1,
  primary key(project_id,source_id),
  foreign key(project_id,source_id) references orka.project_sources(project_id,id) on delete cascade
);
create table if not exists orka.repository_access_requests(
  id uuid primary key,
  project_id uuid not null,
  source_id uuid not null,
  requester uuid not null,
  github_id text not null,
  github_login text not null,
  repository_id text not null,
  full_name text not null,
  reason text not null,
  status text not null check(status in ('requested','waiting_on_github','invitation_pending','verified','rejected','canceled','expired')),
  revision bigint not null default 1,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,source_id) references orka.project_sources(project_id,id) on delete cascade
);
create unique index if not exists repository_active_request on orka.repository_access_requests(project_id,source_id,requester)
  where status in ('requested','waiting_on_github','invitation_pending');
create table if not exists orka.repository_events(
  id bigserial primary key,
  project_id uuid not null references orka.projects on delete cascade,
  source_id uuid not null,
  actor uuid not null,
  action text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists orka.github_webhook_deliveries(id uuid primary key,created_at timestamptz not null default now());
