-- Initial Orka schema. The migration runner applies this file and its ledger entry atomically.

create table orka.projects(id uuid primary key, name text not null, revision bigint not null default 0, created_by uuid not null,
  archived_at timestamptz,
  lifecycle_revision bigint not null default 0,
  governed boolean not null default false,
  policy_revision bigint not null default 0,
  policy jsonb,
  source_model integer not null default 0,
  remote_key text check (remote_key is null or remote_key ~ '^[0-9a-f]{64}$'),
  last_sync_at timestamptz,
  role_policies jsonb);

create table orka.members(project_id uuid references orka.projects on delete cascade, user_id uuid not null, role text not null check(role in ('owner','admin','member')), primary key(project_id,user_id));

create table orka.invites(token_hash text primary key, project_id uuid references orka.projects on delete cascade, expires_at timestamptz not null);

create table orka.devices(id uuid primary key, owner uuid not null, name text not null, last_seen timestamptz not null default now(),
  hardware_family text);

create table orka.blobs(project_id uuid references orka.projects on delete cascade, hash text not null, size bigint not null, primary key(project_id,hash));

create table orka.resources(project_id uuid references orka.projects on delete cascade, id uuid not null, revision bigint not null, payload jsonb not null, primary key(project_id,id));

create table orka.snapshots(project_id uuid references orka.projects on delete cascade, resource_id uuid not null, revision bigint not null, payload jsonb not null, primary key(project_id,resource_id,revision));

create table orka.conflicts(id uuid primary key, project_id uuid references orka.projects on delete cascade, resource_id uuid not null, payload jsonb not null, resolved boolean not null default false);

create table orka.events(project_id uuid references orka.projects on delete cascade, revision bigint not null, payload jsonb not null, primary key(project_id,revision));

create table orka.receipts(project_id uuid references orka.projects on delete cascade, author uuid not null, id uuid not null, request_hash text not null, payload jsonb not null, primary key(project_id,author,id));

create table orka.presence(project_id uuid references orka.projects on delete cascade, resource_id uuid not null, device_id uuid references orka.devices on delete cascade, owner uuid not null, last_seen timestamptz not null default now(), primary key(project_id,resource_id,device_id));

create table orka.env_profiles(user_id uuid primary key, label text not null,
  email text);

create table orka.env_devices(id uuid primary key, owner uuid not null, payload jsonb not null);

create table orka.env_sets(
  project_id uuid references orka.projects on delete cascade, id uuid not null,
  revision bigint not null, header jsonb not null, ciphertext text not null,
  updated_at timestamptz not null default now(), primary key(project_id,id)
);

create table orka.env_headers(
  project_id uuid not null, set_id uuid not null, revision bigint not null, header jsonb not null,
  primary key(project_id,set_id,revision),
  foreign key(project_id,set_id) references orka.env_sets(project_id,id) on delete cascade
);

create table orka.env_receipts(
  project_id uuid references orka.projects on delete cascade, author uuid not null, id uuid not null,
  request_hash text not null, payload jsonb not null, primary key(project_id,author,id)
);

create table orka.env_nonces(
  project_id uuid not null, set_id uuid not null, nonce uuid not null,
  primary key(project_id,set_id,nonce),
  foreign key(project_id,set_id) references orka.env_sets(project_id,id) on delete cascade
);

create table orka.env_activity(
  id bigserial primary key, project_id uuid references orka.projects on delete cascade,
  set_id uuid not null, author uuid not null, device_id uuid not null,
  revision bigint not null, action text not null, created_at timestamptz not null default now()
);

create table orka.project_receipts(
  author uuid not null, id uuid not null, request_hash text not null,
  payload jsonb not null, primary key(author,id)
);

create table orka.project_blob_cleanup(project_id uuid primary key);

create table orka.member_policy(
  project_id uuid references orka.projects on delete cascade, user_id uuid not null,
  class text not null, rule jsonb not null, primary key(project_id,user_id,class)
);

create table orka.resource_access(
  project_id uuid references orka.projects on delete cascade, resource_id uuid not null,
  user_id uuid not null, rule jsonb not null, primary key(project_id,resource_id,user_id)
);

create table orka.blob_uploads(
  project_id uuid references orka.projects on delete cascade, hash text not null,
  author uuid not null, primary key(project_id,hash,author)
);

create table orka.review_requests(
  project_id uuid references orka.projects on delete cascade, id uuid not null,
  author uuid not null, request_hash text not null, payload jsonb not null,
  content jsonb not null, primary key(project_id,id)
);

create table orka.notification_reads(
  project_id uuid references orka.projects on delete cascade, user_id uuid not null,
  request_id uuid not null, preview_hash text not null, primary key(project_id,user_id,request_id)
);

create table orka.env_replacements(
  project_id uuid references orka.projects on delete cascade, set_id uuid not null,
  replacement_id uuid, disabled boolean not null default true,
  primary key(project_id,set_id)
);

create table orka.management_logs(
  id bigserial primary key,
  project_id uuid not null references orka.projects on delete cascade,
  actor uuid, subject uuid,
  project_wide boolean not null default false,
  dedupe_key text,
  payload jsonb not null,
  unique(project_id,dedupe_key)
);

create table orka.project_sources(
  project_id uuid not null references orka.projects on delete cascade,
  id uuid not null,
  name text not null check(length(name) between 1 and 128),
  primary key(project_id,id)
);

create table orka.mcp_clients(id text primary key, metadata jsonb not null);

create table orka.mcp_pending(hash text primary key, cookie_hash text not null, payload jsonb not null, expires_at timestamptz not null);

create table orka.mcp_codes(hash text primary key, payload jsonb not null, expires_at timestamptz not null);

create table orka.mcp_tokens(access_hash text primary key, refresh_hash text unique not null, family uuid not null, client_id text references orka.mcp_clients on delete cascade, user_id uuid not null, resource text not null, access_expires_at timestamptz not null, refresh_expires_at timestamptz not null, revoked boolean not null default false);

create table orka.profiles(
  user_id uuid primary key,
  display_name text not null check (char_length(display_name) between 1 and 80),
  avatar_url text check (avatar_url is null or (octet_length(avatar_url) <= 2048 and avatar_url like 'https://avatars.githubusercontent.com/%')),
  source text not null check (source in ('github','email','user')),
  updated_at timestamptz not null default now(),
  job_role text check (job_role is null or char_length(job_role) <= 80),
  avatar_data text check (avatar_data is null or (octet_length(avatar_data) <= 700000 and avatar_data like 'data:image/png;base64,%'))
);

create table orka.project_create_receipts(
  user_id uuid not null,
  request_id uuid not null,
  request_hash text not null,
  project_id uuid not null references orka.projects(id) on delete cascade,
  primary key(user_id,request_id)
);

create table orka.policy_operations(
  project_id uuid references orka.projects on delete cascade,
  operation_id uuid not null,
  author uuid not null,
  request_hash text not null,
  result jsonb not null,
  primary key(project_id,operation_id)
);

create table orka.policy_migrations(
  project_id uuid primary key references orka.projects on delete cascade,
  author uuid not null,
  confirmed_at timestamptz not null default now(),
  previous jsonb not null
);

create index env_activity_version on orka.env_activity(project_id,set_id,revision);
create index management_logs_project_page on orka.management_logs(project_id,id desc);
create unique index resource_source_logical_path on orka.resources
  (project_id,coalesce(payload->>'sourceId',''),(payload->>'kind'),(payload->>'logicalPath'));
create index mcp_token_family on orka.mcp_tokens(family);
create index mcp_pending_expiry on orka.mcp_pending(expires_at);
create index mcp_codes_expiry on orka.mcp_codes(expires_at);
create index mcp_tokens_expiry on orka.mcp_tokens(refresh_expires_at);
create index project_remote_key on orka.projects(remote_key) where remote_key is not null;

create function orka.protect_management_log() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' and not exists(select 1 from orka.projects where id=OLD.project_id) then return OLD; end if;
  raise exception 'Management logs are append-only';
end;
$$;
create trigger management_log_immutable before update or delete on orka.management_logs for each row execute function orka.protect_management_log();
