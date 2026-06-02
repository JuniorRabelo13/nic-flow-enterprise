import { enterpriseEnv } from '../../../enterprise/config/env'
import { createOutreachDomainError } from './outreach-errors'

type RuntimeContext = Record<string, unknown> | undefined

const withRuntimeContext = (action: string, context?: RuntimeContext) => ({
  action,
  environment: enterpriseEnv.appEnv,
  ...(context ?? {}),
})

export const isLocalDevEnvironment = () => enterpriseEnv.appEnv === 'development'

export const shouldAllowOutreachLocalFallback = () => isLocalDevEnvironment()

export const throwOutreachLocalFallbackDisabled = (action: string, context?: RuntimeContext): never => {
  throw createOutreachDomainError(
    'OUTREACH_LOCAL_FALLBACK_DISABLED',
    'O fallback local está desativado neste ambiente.',
    withRuntimeContext(action, context),
  )
}

export const throwOutreachBackendUnavailable = (action: string, context?: RuntimeContext): never => {
  throw createOutreachDomainError(
    'OUTREACH_BACKEND_UNAVAILABLE',
    'Esta ação exige conexão real com o backend.',
    withRuntimeContext(action, context),
  )
}

export const throwOutreachPersistenceUnavailable = (action: string, context?: RuntimeContext): never => {
  throw createOutreachDomainError(
    'OUTREACH_PERSISTENCE_UNAVAILABLE',
    'O serviço de persistência do módulo não está disponível.',
    withRuntimeContext(action, context),
  )
}

export const throwOutreachReadUnavailable = (action: string, context?: RuntimeContext): never => {
  throw createOutreachDomainError(
    'OUTREACH_BACKEND_UNAVAILABLE',
    'Não foi possível carregar os dados reais do módulo. Verifique a conexão com o backend.',
    withRuntimeContext(action, context),
  )
}
