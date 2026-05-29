create or replace function public.is_workspace_member(target_workspace_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.workspace_member_role(target_workspace_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.workspace_members
  where workspace_id = target_workspace_id
    and user_id = auth.uid()
  limit 1;
$$;

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

alter table public.workspaces
  add column if not exists updated_at timestamptz not null default now();

alter table public.workspace_members
  add column if not exists updated_at timestamptz not null default now();

alter table public.workspaces
  add constraint workspaces_created_by_auth_user_fk
  foreign key (created_by)
  references auth.users (id)
  on delete cascade
  not valid;

alter table public.workspace_members
  add constraint workspace_members_user_auth_user_fk
  foreign key (user_id)
  references auth.users (id)
  on delete cascade
  not valid;

drop trigger if exists touch_workspaces_updated_at on public.workspaces;
create trigger touch_workspaces_updated_at
  before update on public.workspaces
  for each row
  execute function public.touch_updated_at();

drop trigger if exists touch_workspace_members_updated_at on public.workspace_members;
create trigger touch_workspace_members_updated_at
  before update on public.workspace_members
  for each row
  execute function public.touch_updated_at();

drop policy if exists "tenant_select_workspaces" on public.workspaces;
drop policy if exists "tenant_insert_workspaces" on public.workspaces;
drop policy if exists "tenant_select_workspace_members" on public.workspace_members;
drop policy if exists "tenant_insert_workspace_owner_membership" on public.workspace_members;
drop policy if exists "tenant_update_workspaces" on public.workspaces;
drop policy if exists "tenant_select_workspace_members_by_workspace" on public.workspace_members;
drop policy if exists "tenant_manage_workspace_members" on public.workspace_members;

create policy "tenant_select_workspaces"
  on public.workspaces
  for select
  using (public.is_workspace_member(id));

create policy "tenant_update_workspaces"
  on public.workspaces
  for update
  using (public.workspace_member_role(id) in ('owner', 'admin'))
  with check (public.workspace_member_role(id) in ('owner', 'admin'));

create policy "tenant_select_workspace_members_by_workspace"
  on public.workspace_members
  for select
  using (public.is_workspace_member(workspace_id));

create policy "tenant_manage_workspace_members"
  on public.workspace_members
  for all
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id) in ('owner', 'admin'));

create or replace function public.create_workspace(workspace_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_name text;
  created_workspace public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  clean_name := nullif(trim(workspace_name), '');
  if clean_name is null or char_length(clean_name) > 120 then
    raise exception 'Workspace name must be between 1 and 120 characters';
  end if;

  insert into public.workspaces (id, name, created_by)
  values (gen_random_uuid()::text, clean_name, auth.uid())
  returning * into created_workspace;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (created_workspace.id, auth.uid(), 'owner');

  return created_workspace;
end;
$$;

revoke all on function public.is_workspace_member(text) from public;
revoke all on function public.workspace_member_role(text) from public;
revoke all on function public.create_workspace(text) from public;

grant execute on function public.is_workspace_member(text) to authenticated;
grant execute on function public.workspace_member_role(text) to authenticated;
grant execute on function public.create_workspace(text) to authenticated;
