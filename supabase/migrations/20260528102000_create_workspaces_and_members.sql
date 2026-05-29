create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id text not null references public.workspaces (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

create policy "tenant_select_workspaces"
  on public.workspaces
  for select
  using (
    id in (
      select workspace_id
      from public.workspace_members
      where user_id = auth.uid()
    )
  );

create policy "tenant_insert_workspaces"
  on public.workspaces
  for insert
  with check (created_by = auth.uid());

create policy "tenant_select_workspace_members"
  on public.workspace_members
  for select
  using (user_id = auth.uid());

create policy "tenant_insert_workspace_owner_membership"
  on public.workspace_members
  for insert
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and workspace_id in (
      select id
      from public.workspaces
      where created_by = auth.uid()
    )
  );
