drop policy if exists "tenant_delete_whatsapp_connections" on public.whatsapp_connections;

create policy "tenant_delete_whatsapp_connections"
  on public.whatsapp_connections
  for delete
  using (
    workspace_id in (
      select workspace_id::text
      from public.workspace_members
      where user_id = auth.uid()
        and role in ('owner', 'admin')
    )
  );
