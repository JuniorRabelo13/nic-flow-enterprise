import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const authErrorPath = path.resolve(
  process.cwd(),
  'src/modules/whatsapp/services/supabase-auth-error.ts',
)

test('Supabase auth null TypeError is normalized to Preview-friendly message', async () => {
  const authErrorModule = await loadTsModule(authErrorPath)

  const message = authErrorModule.getSupabaseAuthErrorMessage(
    new TypeError("Cannot read properties of null (reading 'auth')"),
    'Não foi possível autenticar.',
  )

  assert.equal(message, authErrorModule.supabasePreviewConfigErrorMessage)
})

test('Supabase auth error helper preserves unrelated auth form errors', async () => {
  const authErrorModule = await loadTsModule(authErrorPath)

  const message = authErrorModule.getSupabaseAuthErrorMessage(
    new Error('Invalid login credentials'),
    'Invalid login credentials',
  )

  assert.equal(message, 'Invalid login credentials')
})
