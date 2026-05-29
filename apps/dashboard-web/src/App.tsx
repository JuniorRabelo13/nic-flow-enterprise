import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import './App.css'
import { AuthWorkspaceProvider, useAuthWorkspace } from './modules/auth-workspace'
import { WhatsAppConnectionsPage } from './modules/whatsapp/components/WhatsAppConnectionsPage'

const routes = {
  home: '/',
  whatsappConnections: '/whatsapp/connections',
} as const

const getCurrentPath = () => window.location.pathname

function App() {
  return (
    <AuthWorkspaceProvider>
      <AppRoutes />
    </AuthWorkspaceProvider>
  )
}

const AppRoutes = () => {
  const [path, setPath] = useState(getCurrentPath)

  useEffect(() => {
    const updatePath = () => setPath(getCurrentPath())
    window.addEventListener('popstate', updatePath)
    return () => window.removeEventListener('popstate', updatePath)
  }, [])

  if (path === routes.whatsappConnections) {
    return (
      <ProtectedRoute>
        <WorkspaceWhatsAppConnectionsPage />
      </ProtectedRoute>
    )
  }

  return (
    <ProtectedRoute>
      <HomePage />
    </ProtectedRoute>
  )
}

const WorkspaceWhatsAppConnectionsPage = () => {
  const { activeWorkspace } = useAuthWorkspace()

  if (!activeWorkspace) {
    return null
  }

  return <WhatsAppConnectionsPage workspaceId={activeWorkspace.id} workspaceName={activeWorkspace.name} />
}

const ProtectedRoute = ({ children }: { children: ReactNode }) => {
  const { activeWorkspace, authReady, isConfigured, loading, session } = useAuthWorkspace()

  if (!isConfigured) {
    return <SupabaseConfigScreen />
  }

  if (!authReady || loading) {
    return <AppStatusScreen message="Carregando sessão..." />
  }

  if (!session) {
    return <LoginScreen />
  }

  if (!activeWorkspace) {
    return <WorkspaceSetupScreen />
  }

  return (
    <>
      <WorkspaceTopbar />
      {children}
    </>
  )
}

const HomePage = () => {
  const { activeWorkspace } = useAuthWorkspace()

  return (
    <main className="app-shell">
      <section className="app-home">
        <div>
          <span>{activeWorkspace?.name ?? 'NIC Flow Enterprise'}</span>
          <h1>Operação SaaS de atendimento e automação</h1>
          <p>Dashboard operacional para conexões WhatsApp, métricas, CRM, billing e fluxos enterprise.</p>
        </div>

        <nav className="app-route-list" aria-label="Módulos principais">
          <a href={routes.whatsappConnections}>WhatsApp Connections</a>
        </nav>
      </section>
    </main>
  )
}

const LoginScreen = () => {
  const { error, signInWithPassword, signUpWithPassword } = useAuthWorkspace()
  const [email, setEmail] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      if (mode === 'sign-in') {
        await signInWithPassword(email, password)
      } else {
        await signUpWithPassword(email, password)
      }
    } catch (caughtError) {
      setFormError(caughtError instanceof Error ? caughtError.message : 'Não foi possível autenticar.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="app-auth-card">
        <span>NIC Flow Enterprise</span>
        <h1>{mode === 'sign-in' ? 'Entrar' : 'Criar acesso'}</h1>
        <form className="app-auth-form" onSubmit={submit}>
          <label>
            Email
            <input autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Senha
            <input autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {(formError || error) ? <div className="app-inline-error" role="alert">{formError ?? error}</div> : null}
          <button disabled={submitting} type="submit">{mode === 'sign-in' ? 'Entrar' : 'Criar conta'}</button>
        </form>
        <button className="app-secondary-action" type="button" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
          {mode === 'sign-in' ? 'Criar novo acesso' : 'Já tenho acesso'}
        </button>
      </section>
    </main>
  )
}

const WorkspaceSetupScreen = () => {
  const { createWorkspace, error } = useAuthWorkspace()
  const [name, setName] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      await createWorkspace(name)
    } catch (caughtError) {
      setFormError(caughtError instanceof Error ? caughtError.message : 'Não foi possível criar o workspace.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="app-auth-card">
        <span>Workspace</span>
        <h1>Criar workspace</h1>
        <p>Crie o primeiro workspace para habilitar os módulos do SaaS.</p>
        <form className="app-auth-form" onSubmit={submit}>
          <label>
            Nome do workspace
            <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          {(formError || error) ? <div className="app-inline-error" role="alert">{formError ?? error}</div> : null}
          <button disabled={submitting || !name.trim()} type="submit">Criar workspace</button>
        </form>
      </section>
    </main>
  )
}

const WorkspaceTopbar = () => {
  const { activeMembership, activeWorkspace, selectWorkspace, signOut, workspaces } = useAuthWorkspace()

  return (
    <header className="app-topbar">
      <a href={routes.home}>NIC Flow</a>
      <div>
        <select aria-label="Workspace ativo" value={activeWorkspace?.id ?? ''} onChange={(event) => selectWorkspace(event.target.value)}>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <span>{activeMembership?.role ?? 'member'}</span>
        <button type="button" onClick={() => void signOut()}>Sair</button>
      </div>
    </header>
  )
}

const SupabaseConfigScreen = () => (
  <AppStatusScreen message="Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para habilitar autenticação." />
)

const AppStatusScreen = ({ message }: { message: string }) => (
  <main className="app-shell">
    <section className="app-auth-card">
      <span>NIC Flow Enterprise</span>
      <h1>{message}</h1>
    </section>
  </main>
)

export default App
