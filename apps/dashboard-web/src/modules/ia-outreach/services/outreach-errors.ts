import { type OutreachDomainError, type OutreachErrorCode } from '../types'

type ConstraintMapping = {
  code: OutreachErrorCode
  message: string
}

type ErrorLike = {
  code?: unknown
  message?: unknown
  details?: unknown
  hint?: unknown
  constraint?: unknown
}

export type OutreachErrorTelemetry = {
  code: OutreachErrorCode
  constraint: string | null
  safeMessage: string
}

const uniqueViolationCode = '23505'

const constraintMappings: Record<string, ConstraintMapping> = {
  uq_outreach_variants_execution_variant_index: {
    code: 'DUPLICATE_VARIANT_INDEX',
    message: 'Esta execução já possui uma variação com este índice.',
  },
  uq_outreach_recipients_active_phone_per_execution: {
    code: 'DUPLICATE_ACTIVE_RECIPIENT',
    message: 'Este telefone já está ativo nesta execução.',
  },
  uq_outreach_queue_active_recipient_per_execution: {
    code: 'DUPLICATE_ACTIVE_QUEUE_ITEM',
    message: 'Este destinatário já possui item ativo na fila desta execução.',
  },
  uq_outreach_active_campaign_per_account: {
    code: 'DUPLICATE_ACTIVE_ACCOUNT_CAMPAIGN',
    message: 'Esta conta já possui uma execução ativa desta campanha.',
  },
  uq_outreach_open_conversation_per_account_phone: {
    code: 'DUPLICATE_OPEN_CONVERSATION',
    message: 'Esta conta já possui uma conversa aberta com este telefone.',
  },
}

const fallbackMessage = 'Não foi possível concluir a ação. Verifique os dados e tente novamente.'

const createDomainError = (
  code: OutreachErrorCode,
  message: string,
  cause?: unknown,
  details?: Record<string, unknown>,
): OutreachDomainError => {
  const error = new Error(message) as OutreachDomainError
  error.name = 'OutreachDomainError'
  error.code = code
  if (cause !== undefined) {
    ;(error as Error & { cause?: unknown }).cause = cause
  }
  if (details) {
    error.details = details
  }
  return error
}

export const createOutreachDomainError = (
  code: OutreachErrorCode,
  message: string,
  details?: Record<string, unknown>,
): OutreachDomainError => createDomainError(code, message, undefined, details)

const safeString = (value: unknown) => (typeof value === 'string' ? value : '')

const extractConstraintName = (error: ErrorLike): string | null => {
  const directConstraint = safeString(error.constraint)
  if (directConstraint) {
    return directConstraint
  }

  const source = [safeString(error.message), safeString(error.details), safeString(error.hint)]
    .filter((value) => value.length > 0)
    .join(' ')

  const quotedConstraintMatch = source.match(/constraint\s+"([^"]+)"/i)
  if (quotedConstraintMatch?.[1]) {
    return quotedConstraintMatch[1]
  }

  const quotedIndexMatch = source.match(/index\s+"([^"]+)"/i)
  if (quotedIndexMatch?.[1]) {
    return quotedIndexMatch[1]
  }

  const knownConstraint = Object.keys(constraintMappings).find((constraint) => source.includes(constraint))
  return knownConstraint ?? null
}

const normalizeManualDomainSignals = (error: ErrorLike, fallbackCode: OutreachErrorCode) => {
  const message = safeString(error.message)

  if (message.includes('fallback local está desativado')) {
    return createDomainError('OUTREACH_LOCAL_FALLBACK_DISABLED', 'O fallback local está desativado neste ambiente.', error)
  }

  if (message.includes('persistência do módulo não está disponível')) {
    return createDomainError('OUTREACH_PERSISTENCE_UNAVAILABLE', 'O serviço de persistência do módulo não está disponível.', error)
  }

  if (message.includes('exige conexão real com o backend')) {
    return createDomainError('OUTREACH_BACKEND_UNAVAILABLE', 'Esta ação exige conexão real com o backend.', error)
  }

  if (
    message.includes('fora do workspace permitido')
    || message.includes('Conta não pertence ao vínculo conta+campanha informado')
  ) {
    return createDomainError('WORKSPACE_SCOPE_VIOLATION', 'A ação não pertence ao workspace atual.', error)
  }

  if (message.includes('Não foi possível validar o workspace desta operação.')) {
    return createDomainError('OUTREACH_WORKSPACE_REQUIRED', 'Não foi possível validar o workspace desta operação.', error)
  }

  if (
    message.includes('Execução conta+campanha não encontrada')
    || message.includes('account_campaign_id é obrigatório')
    || message.includes('Conta ou vínculo conta+campanha não encontrado')
  ) {
    return createDomainError('INVALID_ACCOUNT_CAMPAIGN', 'Execução conta+campanha inválida para esta ação.', error)
  }

  return createDomainError(fallbackCode, message || fallbackMessage, error)
}

export const isOutreachDomainError = (error: unknown): error is OutreachDomainError => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const maybeError = error as Partial<OutreachDomainError>
  return maybeError.name === 'OutreachDomainError' && typeof maybeError.code === 'string'
}

export const normalizeOutreachError = (
  error: unknown,
  fallbackCode: OutreachErrorCode = 'UNKNOWN_OUTREACH_ERROR',
): OutreachDomainError => {
  if (isOutreachDomainError(error)) {
    return error
  }

  if (!error || typeof error !== 'object') {
    return createDomainError(fallbackCode, fallbackMessage, error)
  }

  const source = error as ErrorLike
  const code = safeString(source.code)
  const constraint = extractConstraintName(source)

  if (code === uniqueViolationCode || constraint) {
    const mapping = constraint ? constraintMappings[constraint] : undefined
    if (mapping) {
      return createDomainError(mapping.code, mapping.message, error, constraint ? { constraint } : undefined)
    }

    return createDomainError(fallbackCode, fallbackMessage, error, constraint ? { constraint } : undefined)
  }

  return normalizeManualDomainSignals(source, fallbackCode)
}

export const rethrowAsOutreachDomainError = (
  error: unknown,
  fallbackCode: OutreachErrorCode = 'UNKNOWN_OUTREACH_ERROR',
): never => {
  throw normalizeOutreachError(error, fallbackCode)
}

export const extractOutreachErrorTelemetry = (
  error: unknown,
  fallbackCode: OutreachErrorCode = 'UNKNOWN_OUTREACH_ERROR',
): OutreachErrorTelemetry => {
  const normalized = normalizeOutreachError(error, fallbackCode)
  const constraint = safeString(normalized.details?.constraint)

  return {
    code: normalized.code,
    constraint: constraint || null,
    safeMessage: normalized.message || fallbackMessage,
  }
}
