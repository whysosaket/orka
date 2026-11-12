alter table orka.mcp_tokens add column if not exists scopes text not null default 'orka.read';
create table if not exists orka.mcp_operations(
  project_id uuid not null references orka.projects on delete cascade,
  author uuid not null,
  id uuid not null,
  request_hash text not null,
  payload jsonb not null,
  primary key(project_id,author,id)
);
