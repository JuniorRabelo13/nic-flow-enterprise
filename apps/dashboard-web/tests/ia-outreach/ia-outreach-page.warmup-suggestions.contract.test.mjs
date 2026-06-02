import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const pagePath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/components/IaOutreachPage.tsx',
)

test('IaOutreachPage keeps safe fallback message and warmup-suggestions telemetry wiring', async () => {
  const source = await fs.readFile(pagePath, 'utf8')

  assert.match(source, /const warmupSuggestionUnavailableMessage = 'Sugestão de aquecimento indisponível no momento\.'/)
  assert.match(source, /action:\s*'load_warmup_suggestions'/)
  assert.match(source, /const normalizedError = normalizeOutreachError\(error\)/)
  assert.match(source, /setWarmupSuggestionFeedback\(warmupSuggestionUnavailableMessage\)/)
})
