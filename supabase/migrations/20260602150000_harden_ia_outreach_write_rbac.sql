-- Harden IA Outreach write policies.
-- SELECT remains available to active workspace members through public.is_workspace_member.
-- INSERT/UPDATE/DELETE are restricted to workspace owner/admin roles.

do $$
begin
  if to_regprocedure('public.is_workspace_member(text)') is null then
    raise exception 'Function public.is_workspace_member(text) was not found.'
      using errcode = 'undefined_function';
  end if;

  if to_regprocedure('public.workspace_member_role(text)') is null then
    raise exception 'Function public.workspace_member_role(text) was not found.'
      using errcode = 'undefined_function';
  end if;

  if to_regclass('public.whatsapp_outreach_accounts') is null then
    raise exception 'Required table public.whatsapp_outreach_accounts was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_campaigns') is null then
    raise exception 'Required table public.outreach_campaigns was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_account_campaigns') is null then
    raise exception 'Required table public.outreach_account_campaigns was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_message_variants') is null then
    raise exception 'Required table public.outreach_message_variants was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_recipients') is null then
    raise exception 'Required table public.outreach_recipients was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_warmup_events') is null then
    raise exception 'Required table public.outreach_warmup_events was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_message_queue') is null then
    raise exception 'Required table public.outreach_message_queue was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_conversations') is null then
    raise exception 'Required table public.outreach_conversations was not found.'
      using errcode = 'undefined_table';
  end if;

  if to_regclass('public.outreach_conversation_messages') is null then
    raise exception 'Required table public.outreach_conversation_messages was not found.'
      using errcode = 'undefined_table';
  end if;
end;
$$;

drop policy if exists whatsapp_outreach_accounts_member_insert on public.whatsapp_outreach_accounts;
drop policy if exists whatsapp_outreach_accounts_member_update on public.whatsapp_outreach_accounts;
drop policy if exists whatsapp_outreach_accounts_member_delete on public.whatsapp_outreach_accounts;
create policy whatsapp_outreach_accounts_member_insert
  on public.whatsapp_outreach_accounts
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy whatsapp_outreach_accounts_member_update
  on public.whatsapp_outreach_accounts
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy whatsapp_outreach_accounts_member_delete
  on public.whatsapp_outreach_accounts
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_campaigns_member_insert on public.outreach_campaigns;
drop policy if exists outreach_campaigns_member_update on public.outreach_campaigns;
drop policy if exists outreach_campaigns_member_delete on public.outreach_campaigns;
create policy outreach_campaigns_member_insert
  on public.outreach_campaigns
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_campaigns_member_update
  on public.outreach_campaigns
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_campaigns_member_delete
  on public.outreach_campaigns
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_account_campaigns_member_insert on public.outreach_account_campaigns;
drop policy if exists outreach_account_campaigns_member_update on public.outreach_account_campaigns;
drop policy if exists outreach_account_campaigns_member_delete on public.outreach_account_campaigns;
create policy outreach_account_campaigns_member_insert
  on public.outreach_account_campaigns
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_account_campaigns_member_update
  on public.outreach_account_campaigns
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_account_campaigns_member_delete
  on public.outreach_account_campaigns
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_message_variants_member_insert on public.outreach_message_variants;
drop policy if exists outreach_message_variants_member_update on public.outreach_message_variants;
drop policy if exists outreach_message_variants_member_delete on public.outreach_message_variants;
create policy outreach_message_variants_member_insert
  on public.outreach_message_variants
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_message_variants_member_update
  on public.outreach_message_variants
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_message_variants_member_delete
  on public.outreach_message_variants
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_recipients_member_insert on public.outreach_recipients;
drop policy if exists outreach_recipients_member_update on public.outreach_recipients;
drop policy if exists outreach_recipients_member_delete on public.outreach_recipients;
create policy outreach_recipients_member_insert
  on public.outreach_recipients
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_recipients_member_update
  on public.outreach_recipients
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_recipients_member_delete
  on public.outreach_recipients
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_warmup_events_member_insert on public.outreach_warmup_events;
drop policy if exists outreach_warmup_events_member_update on public.outreach_warmup_events;
drop policy if exists outreach_warmup_events_member_delete on public.outreach_warmup_events;
create policy outreach_warmup_events_member_insert
  on public.outreach_warmup_events
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_warmup_events_member_update
  on public.outreach_warmup_events
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_warmup_events_member_delete
  on public.outreach_warmup_events
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_message_queue_member_insert on public.outreach_message_queue;
drop policy if exists outreach_message_queue_member_update on public.outreach_message_queue;
drop policy if exists outreach_message_queue_member_delete on public.outreach_message_queue;
create policy outreach_message_queue_member_insert
  on public.outreach_message_queue
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_message_queue_member_update
  on public.outreach_message_queue
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_message_queue_member_delete
  on public.outreach_message_queue
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_conversations_member_insert on public.outreach_conversations;
drop policy if exists outreach_conversations_member_update on public.outreach_conversations;
drop policy if exists outreach_conversations_member_delete on public.outreach_conversations;
create policy outreach_conversations_member_insert
  on public.outreach_conversations
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_conversations_member_update
  on public.outreach_conversations
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_conversations_member_delete
  on public.outreach_conversations
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));

drop policy if exists outreach_conversation_messages_member_insert on public.outreach_conversation_messages;
drop policy if exists outreach_conversation_messages_member_update on public.outreach_conversation_messages;
drop policy if exists outreach_conversation_messages_member_delete on public.outreach_conversation_messages;
create policy outreach_conversation_messages_member_insert
  on public.outreach_conversation_messages
  for insert
  to authenticated
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_conversation_messages_member_update
  on public.outreach_conversation_messages
  for update
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'))
  with check (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
create policy outreach_conversation_messages_member_delete
  on public.outreach_conversation_messages
  for delete
  to authenticated
  using (public.workspace_member_role(workspace_id::text) in ('owner', 'admin'));
