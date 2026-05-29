create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  provider_type text not null check (provider_type in ('official', 'qr_session')),
  session_name text not null,
  phone_number text,
  status text not null default 'pending' check (status in ('pending', 'connecting', 'online', 'offline', 'failed', 'disconnecting')),
  qr_code text,
  official_phone_number_id text,
  official_business_account_id text,
  official_access_token text,
  webhook_secret text,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_connections_workspace_idx on public.whatsapp_connections (workspace_id);
create index if not exists whatsapp_connections_status_idx on public.whatsapp_connections (workspace_id, status);

alter table public.whatsapp_connections enable row level security;

create policy "tenant_select_whatsapp_connections"
  on public.whatsapp_connections
  for select
  using (
    workspace_id in (
      select workspace_id::text
      from public.workspace_members
      where user_id = auth.uid()
    )
  );

create policy "tenant_insert_whatsapp_connections"
  on public.whatsapp_connections
  for insert
  with check (
    workspace_id in (
      select workspace_id::text
      from public.workspace_members
      where user_id = auth.uid()
    )
  );

create policy "tenant_update_whatsapp_connections"
  on public.whatsapp_connections
  for update
  using (
    workspace_id in (
      select workspace_id::text
      from public.workspace_members
      where user_id = auth.uid()
    )
  )
  with check (
    workspace_id in (
      select workspace_id::text
      from public.workspace_members
      where user_id = auth.uid()
    )
  );

create policy "tenant_delete_whatsapp_connections"
  on public.whatsapp_connections
  for delete
  using (
    workspace_id in (
      select workspace_id::text
      from public.workspace_members
      where user_id = auth.uid()
    )
  );

comment on column public.whatsapp_connections.official_access_token is 'Encrypted server-side only. Do not write raw tokens from browser clients.';
