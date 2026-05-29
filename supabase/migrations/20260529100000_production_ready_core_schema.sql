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

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop trigger if exists touch_profiles_updated_at on public.profiles;
create trigger touch_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.touch_updated_at();

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row
  execute function public.handle_new_user_profile();

insert into public.profiles (id, email, full_name, avatar_url)
select
  users.id,
  users.email,
  users.raw_user_meta_data ->> 'full_name',
  users.raw_user_meta_data ->> 'avatar_url'
from auth.users
on conflict (id) do nothing;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;

create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

alter table public.workspaces
  add column if not exists slug text,
  add column if not exists status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  add column if not exists plan_id text,
  add column if not exists billing_customer_id text,
  add column if not exists deleted_at timestamptz;

create index if not exists workspaces_created_by_idx on public.workspaces (created_by);
create index if not exists workspaces_status_idx on public.workspaces (status);
create unique index if not exists workspaces_slug_unique_idx
  on public.workspaces (slug)
  where slug is not null and deleted_at is null;

alter table public.workspace_members
  add column if not exists invited_by uuid references auth.users (id) on delete set null,
  add column if not exists accepted_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists last_active_at timestamptz;

create index if not exists workspace_members_user_workspace_idx on public.workspace_members (user_id, workspace_id);
create index if not exists workspace_members_workspace_role_idx on public.workspace_members (workspace_id, role);
create index if not exists workspace_members_workspace_active_idx
  on public.workspace_members (workspace_id)
  where disabled_at is null;

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  token_hash text not null,
  invited_by uuid references auth.users (id) on delete set null,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_invites enable row level security;

drop trigger if exists touch_workspace_invites_updated_at on public.workspace_invites;
create trigger touch_workspace_invites_updated_at
  before update on public.workspace_invites
  for each row
  execute function public.touch_updated_at();

create index if not exists workspace_invites_workspace_idx on public.workspace_invites (workspace_id);
create index if not exists workspace_invites_email_idx on public.workspace_invites (lower(email));
create unique index if not exists workspace_invites_active_email_unique_idx
  on public.workspace_invites (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

drop policy if exists "workspace_invites_select_admin" on public.workspace_invites;
drop policy if exists "workspace_invites_manage_admin" on public.workspace_invites;

create policy "workspace_invites_select_admin"
  on public.workspace_invites
  for select
  to authenticated
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'));

create policy "workspace_invites_manage_admin"
  on public.workspace_invites
  for all
  to authenticated
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id) in ('owner', 'admin'));

grant select, insert, update, delete on public.workspace_invites to authenticated;
grant select, insert, update, delete on public.workspace_invites to service_role;

create table if not exists public.workspace_role_permissions (
  role text not null check (role in ('owner', 'admin', 'member')),
  permission text not null,
  created_at timestamptz not null default now(),
  primary key (role, permission)
);

alter table public.workspace_role_permissions enable row level security;

drop policy if exists "workspace_role_permissions_read" on public.workspace_role_permissions;

create policy "workspace_role_permissions_read"
  on public.workspace_role_permissions
  for select
  to authenticated
  using (true);

grant select on public.workspace_role_permissions to authenticated;
grant select, insert, update, delete on public.workspace_role_permissions to service_role;

insert into public.workspace_role_permissions (role, permission)
values
  ('owner', 'manage_workspace'),
  ('owner', 'manage_members'),
  ('owner', 'manage_integrations'),
  ('owner', 'manage_billing'),
  ('owner', 'send_messages'),
  ('owner', 'view_audit_logs'),
  ('admin', 'manage_members'),
  ('admin', 'manage_integrations'),
  ('admin', 'send_messages'),
  ('member', 'send_messages')
on conflict (role, permission) do nothing;

alter table public.whatsapp_connections
  add column if not exists display_name text,
  add column if not exists provider_instance_id text,
  add column if not exists qr_expires_at timestamptz,
  add column if not exists connected_at timestamptz,
  add column if not exists disconnected_at timestamptz,
  add column if not exists last_error text,
  add column if not exists created_by uuid references auth.users (id) on delete set null,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

update public.whatsapp_connections
set display_name = session_name
where display_name is null;

drop trigger if exists touch_whatsapp_connections_updated_at on public.whatsapp_connections;
create trigger touch_whatsapp_connections_updated_at
  before update on public.whatsapp_connections
  for each row
  execute function public.touch_updated_at();

create index if not exists whatsapp_connections_provider_idx on public.whatsapp_connections (workspace_id, provider_type);
create index if not exists whatsapp_connections_active_idx on public.whatsapp_connections (workspace_id, is_active);
create index if not exists whatsapp_connections_provider_status_idx on public.whatsapp_connections (workspace_id, provider_type, status);
create unique index if not exists whatsapp_connections_workspace_session_unique_idx
  on public.whatsapp_connections (workspace_id, session_name)
  where deleted_at is null;

comment on column public.whatsapp_connections.official_access_token is 'Deprecated legacy field. Store provider secrets in public.integration_secrets only.';
comment on column public.whatsapp_connections.webhook_secret is 'Deprecated legacy field. Store provider secrets in public.integration_secrets only.';

create table if not exists public.integration_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  connection_id uuid references public.whatsapp_connections (id) on delete cascade,
  provider text not null check (provider in ('evolution', 'meta', 'stripe', 'internal')),
  secret_type text not null,
  encrypted_value text not null,
  key_version text not null default 'v1',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz
);

alter table public.integration_secrets enable row level security;

drop trigger if exists touch_integration_secrets_updated_at on public.integration_secrets;
create trigger touch_integration_secrets_updated_at
  before update on public.integration_secrets
  for each row
  execute function public.touch_updated_at();

create index if not exists integration_secrets_workspace_provider_idx on public.integration_secrets (workspace_id, provider);
create index if not exists integration_secrets_connection_idx on public.integration_secrets (connection_id);
create unique index if not exists integration_secrets_active_unique_idx
  on public.integration_secrets (workspace_id, provider, secret_type, coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null;

revoke all on public.integration_secrets from anon;
revoke all on public.integration_secrets from authenticated;
grant select, insert, update, delete on public.integration_secrets to service_role;

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

alter table public.idempotency_keys enable row level security;

drop trigger if exists touch_idempotency_keys_updated_at on public.idempotency_keys;
create trigger touch_idempotency_keys_updated_at
  before update on public.idempotency_keys
  for each row
  execute function public.touch_updated_at();

create index if not exists idempotency_keys_expires_idx on public.idempotency_keys (expires_at);
revoke all on public.idempotency_keys from anon;
revoke all on public.idempotency_keys from authenticated;
grant select, insert, update, delete on public.idempotency_keys to service_role;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text references public.workspaces (id) on delete cascade,
  connection_id uuid references public.whatsapp_connections (id) on delete set null,
  provider text not null check (provider in ('meta', 'evolution', 'stripe', 'internal')),
  event_type text not null,
  provider_event_id text,
  payload jsonb not null,
  headers jsonb not null default '{}'::jsonb,
  signature_valid boolean not null default false,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

alter table public.webhook_events enable row level security;

create index if not exists webhook_events_workspace_created_idx on public.webhook_events (workspace_id, created_at desc);
create index if not exists webhook_events_connection_idx on public.webhook_events (connection_id);
create unique index if not exists webhook_events_provider_event_unique_idx
  on public.webhook_events (provider, provider_event_id)
  where provider_event_id is not null;

revoke all on public.webhook_events from anon;
revoke all on public.webhook_events from authenticated;
grant select, insert, update, delete on public.webhook_events to service_role;

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.whatsapp_connections (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  provider_type text not null check (provider_type in ('official', 'qr_session')),
  client_message_id text,
  provider_message_id text,
  from_number text,
  to_number text,
  message_type text not null default 'text',
  body text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_messages enable row level security;

drop trigger if exists touch_whatsapp_messages_updated_at on public.whatsapp_messages;
create trigger touch_whatsapp_messages_updated_at
  before update on public.whatsapp_messages
  for each row
  execute function public.touch_updated_at();

create index if not exists whatsapp_messages_workspace_created_idx on public.whatsapp_messages (workspace_id, created_at desc);
create index if not exists whatsapp_messages_connection_created_idx on public.whatsapp_messages (connection_id, created_at desc);
create unique index if not exists whatsapp_messages_client_message_unique_idx
  on public.whatsapp_messages (workspace_id, client_message_id)
  where client_message_id is not null;
create unique index if not exists whatsapp_messages_provider_message_unique_idx
  on public.whatsapp_messages (workspace_id, provider_type, provider_message_id)
  where provider_message_id is not null;

drop policy if exists "whatsapp_messages_select_workspace" on public.whatsapp_messages;

create policy "whatsapp_messages_select_workspace"
  on public.whatsapp_messages
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.whatsapp_messages to service_role;

create table if not exists public.message_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  connection_id uuid references public.whatsapp_connections (id) on delete cascade,
  message_id uuid references public.whatsapp_messages (id) on delete cascade,
  job_type text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'succeeded', 'failed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.message_outbox enable row level security;

drop trigger if exists touch_message_outbox_updated_at on public.message_outbox;
create trigger touch_message_outbox_updated_at
  before update on public.message_outbox
  for each row
  execute function public.touch_updated_at();

create index if not exists message_outbox_due_idx on public.message_outbox (status, next_attempt_at);
create index if not exists message_outbox_workspace_idx on public.message_outbox (workspace_id, created_at desc);
revoke all on public.message_outbox from anon;
revoke all on public.message_outbox from authenticated;
grant select, insert, update, delete on public.message_outbox to service_role;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text references public.workspaces (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

create index if not exists audit_logs_workspace_created_idx on public.audit_logs (workspace_id, created_at desc);
create index if not exists audit_logs_actor_created_idx on public.audit_logs (actor_user_id, created_at desc);

drop policy if exists "audit_logs_select_admin" on public.audit_logs;

create policy "audit_logs_select_admin"
  on public.audit_logs
  for select
  to authenticated
  using (
    workspace_id is not null
    and public.workspace_member_role(workspace_id) in ('owner', 'admin')
  );

grant select, insert, update, delete on public.audit_logs to service_role;

create table if not exists public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null unique references public.workspaces (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.billing_customers enable row level security;

drop trigger if exists touch_billing_customers_updated_at on public.billing_customers;
create trigger touch_billing_customers_updated_at
  before update on public.billing_customers
  for each row
  execute function public.touch_updated_at();

drop policy if exists "billing_customers_select_admin" on public.billing_customers;

create policy "billing_customers_select_admin"
  on public.billing_customers
  for select
  to authenticated
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'));

grant select, insert, update, delete on public.billing_customers to service_role;

create table if not exists public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  stripe_subscription_id text unique,
  plan_id text not null,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.billing_subscriptions enable row level security;

drop trigger if exists touch_billing_subscriptions_updated_at on public.billing_subscriptions;
create trigger touch_billing_subscriptions_updated_at
  before update on public.billing_subscriptions
  for each row
  execute function public.touch_updated_at();

create index if not exists billing_subscriptions_workspace_status_idx on public.billing_subscriptions (workspace_id, status);

drop policy if exists "billing_subscriptions_select_admin" on public.billing_subscriptions;

create policy "billing_subscriptions_select_admin"
  on public.billing_subscriptions
  for select
  to authenticated
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'));

grant select, insert, update, delete on public.billing_subscriptions to service_role;

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  source text not null,
  metric text not null,
  quantity numeric not null check (quantity >= 0),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

create index if not exists usage_events_workspace_metric_time_idx on public.usage_events (workspace_id, metric, occurred_at desc);
create unique index if not exists usage_events_idempotency_unique_idx
  on public.usage_events (workspace_id, source, idempotency_key)
  where idempotency_key is not null;

drop policy if exists "usage_events_select_admin" on public.usage_events;

create policy "usage_events_select_admin"
  on public.usage_events
  for select
  to authenticated
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'));

grant select, insert, update, delete on public.usage_events to service_role;
