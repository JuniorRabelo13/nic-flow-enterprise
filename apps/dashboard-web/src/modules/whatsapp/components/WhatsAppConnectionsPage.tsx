import { useMemo, useState } from 'react'
import { trackAction } from '../../../enterprise/observability/actions'
import { whatsappService } from '../services/whatsapp.service'
import { trackWhatsAppMetric } from '../services/whatsapp.analytics'
import { useWhatsAppConnections } from '../hooks/useWhatsAppConnections'
import { type WhatsAppConnection, WhatsAppProviderType } from '../types'
import './whatsapp-connections.css'

const formatDate = (value: string | null) => {
  if (!value) {
    return 'Sem atividade'
  }

  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

const providerLabel = (provider: WhatsAppProviderType) => (provider === WhatsAppProviderType.OFFICIAL ? 'API Oficial Meta' : 'QR Code Session')

type WhatsAppConnectionsPageProps = {
  workspaceId: string
  workspaceName?: string
}

export const WhatsAppConnectionsPage = ({ workspaceId, workspaceName }: WhatsAppConnectionsPageProps) => {
  const [officialForm, setOfficialForm] = useState({ sessionName: '', accessToken: '', phoneNumberId: '', businessAccountId: '' })
  const [qrSessionName, setQrSessionName] = useState('')
  const [qrModal, setQrModal] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; message: string } | null>(null)
  const { connections, loading, setLoading, pushLog } = useWhatsAppConnections(workspaceId)

  const activeSessions = useMemo(() => connections.filter((connection) => connection.status === 'online').length, [connections])

  const showError = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Não foi possível concluir a ação.'
    setFeedback({ type: 'error', message })
    pushLog(`error:${message}`)
  }

  const connectQr = async () => {
    const sessionName = qrSessionName.trim()
    if (!sessionName) {
      setFeedback({ type: 'error', message: 'Informe o nome da sessão.' })
      return
    }

    setFeedback(null)
    setLoading(true)
    try {
      const result = await whatsappService.createQrSession({ workspaceId, sessionName })
      setQrModal(result.qrCode ?? null)
      trackWhatsAppMetric('reconnections', 1, workspaceId)
      await trackAction({ name: 'whatsapp_qr_session_created', workspaceId, metadata: { sessionName } })
      setFeedback({ type: 'success', message: 'Sessão QR criada com sucesso.' })
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }

  const connectOfficial = async () => {
    if (!officialForm.sessionName.trim() || !officialForm.accessToken.trim() || !officialForm.phoneNumberId.trim() || !officialForm.businessAccountId.trim()) {
      setFeedback({ type: 'error', message: 'Preencha todos os campos da API Oficial.' })
      return
    }

    setFeedback(null)
    setLoading(true)
    try {
      await whatsappService.connectOfficial({
        workspaceId,
        sessionName: officialForm.sessionName.trim(),
        accessToken: officialForm.accessToken.trim(),
        phoneNumberId: officialForm.phoneNumberId.trim(),
        businessAccountId: officialForm.businessAccountId.trim(),
      })
      await trackAction({ name: 'whatsapp_official_connection_created', workspaceId, metadata: { phoneNumberId: officialForm.phoneNumberId } })
      pushLog('official_connection_submitted')
      setFeedback({ type: 'success', message: 'Solicitação de conexão oficial enviada.' })
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }

  const disconnect = async (connection: WhatsAppConnection) => {
    setFeedback(null)
    try {
      await whatsappService.disconnect(connection)
      trackWhatsAppMetric('active_sessions', Math.max(0, activeSessions - 1), workspaceId)
      setFeedback({ type: 'success', message: 'Conexão desconectada.' })
    } catch (error) {
      showError(error)
    }
  }

  const reconnect = async (connection: WhatsAppConnection) => {
    setFeedback(null)
    try {
      const result = await whatsappService.reconnect(connection)
      setQrModal(result.qrCode ?? null)
      trackWhatsAppMetric('reconnections', 1, workspaceId)
      setFeedback({ type: 'success', message: 'Reconexão solicitada.' })
    } catch (error) {
      showError(error)
    }
  }

  return (
    <main className="whatsapp-page">
      <section className="whatsapp-shell">
        <div className="whatsapp-heading">
          <span>{workspaceName ?? 'WhatsApp Enterprise'}</span>
          <h1>Escolha como deseja conectar seu WhatsApp</h1>
          <p>Gerencie conexões oficiais Meta e sessões por QR Code por workspace, com realtime, segurança e métricas operacionais.</p>
        </div>

        <div className="whatsapp-provider-grid">
          <article className="whatsapp-provider-card">
            <div>
              <span className="whatsapp-provider-badge">API Oficial Meta</span>
              <h2>Conectar via API Oficial</h2>
              <p>Mais estável, requer aprovação Meta e é ideal para escala.</p>
            </div>
            <div className="whatsapp-form-grid">
              <input type="password" placeholder="Access Token" value={officialForm.accessToken} onChange={(event) => setOfficialForm({ ...officialForm, accessToken: event.target.value })} />
              <input placeholder="Phone Number ID" value={officialForm.phoneNumberId} onChange={(event) => setOfficialForm({ ...officialForm, phoneNumberId: event.target.value })} />
              <input placeholder="Business Account ID" value={officialForm.businessAccountId} onChange={(event) => setOfficialForm({ ...officialForm, businessAccountId: event.target.value })} />
              <input placeholder="Nome da conexão" value={officialForm.sessionName} onChange={(event) => setOfficialForm({ ...officialForm, sessionName: event.target.value })} />
            </div>
            <button disabled={loading || !officialForm.sessionName || !officialForm.accessToken || !officialForm.phoneNumberId || !officialForm.businessAccountId} onClick={connectOfficial}>
              Conectar API Oficial
            </button>
          </article>

          <article className="whatsapp-provider-card">
            <div>
              <span className="whatsapp-provider-badge alt">Evolution API / Baileys</span>
              <h2>Conectar via QR Code</h2>
              <p>Conexão rápida, sem aprovação Meta e ideal para operação imediata.</p>
            </div>
            <div className="whatsapp-form-grid single">
              <input placeholder="Nome da sessão" value={qrSessionName} onChange={(event) => setQrSessionName(event.target.value)} />
            </div>
            <button disabled={loading || !qrSessionName} onClick={connectQr}>
              Gerar QR Code
            </button>
          </article>
        </div>

        {feedback ? <div className={`whatsapp-feedback ${feedback.type}`} role="status">{feedback.message}</div> : null}

        <section className="whatsapp-connections-panel">
          <div className="whatsapp-panel-title">
            <div>
              <span>Realtime</span>
              <h2>Conexões ativas</h2>
            </div>
            <strong>{activeSessions} online</strong>
          </div>

          <div className="whatsapp-connection-list">
            {connections.map((connection) => (
              <article className="whatsapp-connection-row" key={connection.id}>
                <div>
                  <span className={`whatsapp-status ${connection.status}`}>{connection.status}</span>
                  <h3>{connection.session_name}</h3>
                  <p>{connection.phone_number ?? 'Telefone pendente'} · Última atividade: {formatDate(connection.last_seen_at)}</p>
                </div>
                <span className="whatsapp-provider-badge">{providerLabel(connection.provider_type)}</span>
                <div className="whatsapp-row-actions">
                  <button onClick={() => reconnect(connection)}>Reconnect</button>
                  <button className="danger" onClick={() => disconnect(connection)}>Desconectar</button>
                </div>
              </article>
            ))}
            {!loading && connections.length === 0 ? <div className="whatsapp-empty">Nenhuma conexão cadastrada neste workspace.</div> : null}
          </div>
        </section>
      </section>

      {qrModal ? (
        <div className="whatsapp-modal" role="dialog" aria-modal="true">
          <div className="whatsapp-modal-content">
            <h2>Escaneie o QR Code</h2>
            <img src={qrModal} alt="QR Code WhatsApp" />
            <button onClick={() => setQrModal(null)}>Fechar</button>
          </div>
        </div>
      ) : null}
    </main>
  )
}
