create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table public.workspace_members
  add column if not exists accepted_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists status text not null default 'active';

update public.workspace_members
set accepted_at = coalesce(accepted_at, created_at),
    status = coalesce(nullif(status, ''), 'active')
where accepted_at is null
   or status is null
   or status = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_members_status_check'
      and conrelid = 'public.workspace_members'::regclass
  ) then
    alter table public.workspace_members
      add constraint workspace_members_status_check
      check (status in ('active', 'invited', 'suspended', 'disabled'))
      not valid;
  end if;
end;
$$;

create index if not exists workspace_members_active_lookup_idx
  on public.workspace_members (workspace_id, user_id, role, status)
  where deleted_at is null;

alter table public.whatsapp_connections
  add column if not exists provider_instance_id text,
  add column if not exists display_name text,
  add column if not exists qr_expires_at timestamptz,
  add column if not exists connected_at timestamptz,
  add column if not exists disconnected_at timestamptz,
  add column if not exists last_error text,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.whatsapp_connections
set display_name = coalesce(nullif(display_name, ''), session_name)
where display_name is null
   or display_name = '';

drop trigger if exists touch_whatsapp_connections_updated_at on public.whatsapp_connections;
create trigger touch_whatsapp_connections_updated_at
  before update on public.whatsapp_connections
  for each row
  execute function public.touch_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_connections_provider_instance_id_check'
      and conrelid = 'public.whatsapp_connections'::regclass
  ) then
    alter table public.whatsapp_connections
      add constraint whatsapp_connections_provider_instance_id_check
      check (
        provider_instance_id is null
        or provider_instance_id ~ '^[a-zA-Z0-9_-]{16,160}$'
      )
      not valid;
  end if;
end;
$$;

do $$
declare
  duplicate_count integer;
begin
  select count(*)
  into duplicate_count
  from (
    select workspace_id, provider_type, session_name
    from public.whatsapp_connections
    where deleted_at is null
    group by workspace_id, provider_type, session_name
    having count(*) > 1
  ) duplicates;

  if duplicate_count > 0 then
    raise exception 'Preflight failed: % active duplicate whatsapp_connections rows found for (workspace_id, provider_type, session_name). Resolve duplicates before applying unique indexes.', duplicate_count
      using errcode = 'check_violation';
  end if;
end;
$$;

do $$
declare
  duplicate_count integer;
begin
  select count(*)
  into duplicate_count
  from (
    select workspace_id, provider_type, provider_instance_id
    from public.whatsapp_connections
    where deleted_at is null
      and provider_instance_id is not null
    group by workspace_id, provider_type, provider_instance_id
    having count(*) > 1
  ) duplicates;

  if duplicate_count > 0 then
    raise exception 'Preflight failed: % active duplicate whatsapp_connections rows found for (workspace_id, provider_type, provider_instance_id). Resolve duplicates before applying unique indexes.', duplicate_count
      using errcode = 'check_violation';
  end if;
end;
$$;

create unique index if not exists whatsapp_connections_provider_instance_unique_idx
  on public.whatsapp_connections (workspace_id, provider_type, provider_instance_id)
  where deleted_at is null
    and provider_instance_id is not null;

create unique index if not exists whatsapp_connections_workspace_provider_session_unique_idx
  on public.whatsapp_connections (workspace_id, provider_type, session_name)
  where deleted_at is null;

create index if not exists whatsapp_connections_workspace_status_lookup_idx
  on public.whatsapp_connections (workspace_id, status)
  where deleted_at is null;

create index if not exists whatsapp_connections_workspace_provider_status_idx
  on public.whatsapp_connections (workspace_id, provider_type, status)
  where deleted_at is null;

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  scope text not null,
  key text not null,
  request_hash text not null,
  response jsonb,
  status text not null default 'processing' check (status in ('processing', 'succeeded', 'failed')),
  locked_until timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, scope, key)
);

alter table public.idempotency_keys
  add column if not exists request_hash text,
  add column if not exists response jsonb,
  add column if not exists status text not null default 'processing',
  add column if not exists locked_until timestamptz,
  add column if not exists expires_at timestamptz not null default (now() + interval '24 hours'),
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists touch_idempotency_keys_updated_at on public.idempotency_keys;
create trigger touch_idempotency_keys_updated_at
  before update on public.idempotency_keys
  for each row
  execute function public.touch_updated_at();

create unique index if not exists idempotency_keys_workspace_scope_key_unique_idx
  on public.idempotency_keys (workspace_id, scope, key);

create index if not exists idempotency_keys_processing_locks_idx
  on public.idempotency_keys (workspace_id, scope, key, request_hash, status, locked_until);

create index if not exists idempotency_keys_expires_at_idx
  on public.idempotency_keys (expires_at);

alter table public.idempotency_keys enable row level security;
revoke all on public.idempotency_keys from anon;
revoke all on public.idempotency_keys from authenticated;
grant select, insert, update, delete on public.idempotency_keys to service_role;

create table if not exists public.rate_limit_counters (
  workspace_id text not null references public.workspaces (id) on delete cascade,
  scope text not null,
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, scope, window_start)
);

drop trigger if exists touch_rate_limit_counters_updated_at on public.rate_limit_counters;
create trigger touch_rate_limit_counters_updated_at
  before update on public.rate_limit_counters
  for each row
  execute function public.touch_updated_at();

create index if not exists rate_limit_counters_expires_at_idx
  on public.rate_limit_counters (expires_at);

alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon;
revoke all on public.rate_limit_counters from authenticated;
grant select, insert, update, delete on public.rate_limit_counters to service_role;

create or replace function public.consume_rate_limit(
  target_workspace_id text,
  target_scope text,
  window_seconds integer,
  max_requests integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket_start timestamptz;
  consumed_count integer;
begin
  if target_workspace_id is null or target_workspace_id = '' then
    raise exception 'target_workspace_id is required';
  end if;

  if target_scope is null or target_scope = '' then
    raise exception 'target_scope is required';
  end if;

  if window_seconds <= 0 or max_requests <= 0 then
    raise exception 'window_seconds and max_requests must be positive';
  end if;

  bucket_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / window_seconds) * window_seconds
  );

  insert into public.rate_limit_counters (
    workspace_id,
    scope,
    window_start,
    count,
    expires_at
  )
  values (
    target_workspace_id,
    target_scope,
    bucket_start,
    1,
    bucket_start + ((window_seconds * 3) * interval '1 second')
  )
  on conflict (workspace_id, scope, window_start)
  do update
    set count = public.rate_limit_counters.count + 1,
        expires_at = excluded.expires_at,
        updated_at = now()
    where public.rate_limit_counters.count < max_requests
  returning count into consumed_count;

  return consumed_count is not null;
end;
$$;

revoke all on function public.consume_rate_limit(text, text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role;
