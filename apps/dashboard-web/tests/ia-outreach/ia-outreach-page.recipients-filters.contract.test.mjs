import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const pagePath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/components/IaOutreachPage.tsx',
)

test('IaOutreachPage keeps recipients filter + paginated contract wiring', async () => {
  const source = await fs.readFile(pagePath, 'utf8')

  assert.match(source, /recipientStatusFilterByExecution/)
  assert.match(source, /recipientSearchAppliedByExecution/)
  assert.match(source, /applyRecipientFilters/)
  assert.match(source, /listRecipientsByAccountCampaignPaginated\(\{/)
  assert.match(source, /page:\s*requestedPage/)
  assert.match(source, /pageSize:\s*recipientsPageSize/)
  assert.match(source, /status:\s*statusForQuery/)
  assert.match(source, /search:\s*hasSearchFilter\s*\?\s*appliedSearch\s*:\s*undefined/)
  assert.match(source, /Limpar filtros/)
  assert.match(source, /Exibindo\s*\{recipientStartPosition\}-\{recipientEndPosition\}\s*de\s*\{totalExecutionRecipients\}\s*destinatários/)
})

test('IaOutreachPage clear filters flow resets status/search/page and reloads recipients', async () => {
  const source = await fs.readFile(pagePath, 'utf8')

  assert.match(source, /status:\s*'all'/)
  assert.match(source, /search:\s*''/)
  assert.match(source, /setRecipientSearchAppliedByExecution\(/)
  assert.match(source, /\[accountCampaignId\]:\s*nextSearch/)
  assert.match(source, /setRecipientPageByExecution\(/)
  assert.match(source, /\[accountCampaignId\]:\s*1/)
  assert.match(source, /force:\s*true/)
  assert.match(source, /page:\s*1/)
  assert.match(source, /status:\s*nextStatus/)
  assert.match(source, /search:\s*nextSearch/)
})
