alter table public.whatsapp_connections
  add constraint whatsapp_connections_workspace_fk
  foreign key (workspace_id)
  references public.workspaces (id)
  on delete cascade
  not valid;

drop policy if exists "tenant_select_whatsapp_connections" on public.whatsapp_connections;
drop policy if exists "tenant_insert_whatsapp_connections" on public.whatsapp_connections;
drop policy if exists "tenant_update_whatsapp_connections" on public.whatsapp_connections;
drop policy if exists "tenant_delete_whatsapp_connections" on public.whatsapp_connections;

create policy "tenant_select_whatsapp_connections"
  on public.whatsapp_connections
  for select
  using (public.is_workspace_member(workspace_id));

create policy "tenant_insert_whatsapp_connections"
  on public.whatsapp_connections
  for insert
  with check (public.is_workspace_member(workspace_id));

create policy "tenant_update_whatsapp_connections"
  on public.whatsapp_connections
  for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "tenant_delete_whatsapp_connections"
  on public.whatsapp_connections
  for delete
  using (public.workspace_member_role(workspace_id) in ('owner', 'admin'));
