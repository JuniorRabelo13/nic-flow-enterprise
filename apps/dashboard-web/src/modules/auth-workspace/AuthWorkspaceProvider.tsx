import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { type Session } from '@supabase/supabase-js'
import {
  getSupabaseAuthErrorMessage,
  hasSupabaseConfig,
  requireSupabaseAuth,
  supabasePreviewConfigErrorMessage,
} from '../whatsapp/services/supabase.client'
import { AuthWorkspaceContext, type AuthWorkspaceContextValue, type Workspace, type WorkspaceMember } from './authWorkspaceContext'

const activeWorkspaceStorageKey = 'nic.activeWorkspaceId'

export const AuthWorkspaceProvider = ({ children }: { children: ReactNode }) => {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => localStorage.getItem(activeWorkspaceStorageKey))
  const [authReady, setAuthReady] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [memberships, setMemberships] = useState<WorkspaceMember[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  const user = session?.user ?? null

  const selectWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId)
    localStorage.setItem(activeWorkspaceStorageKey, workspaceId)
  }, [])

  const refreshWorkspaces = useCallback(async () => {
    if (!session) {
      setWorkspaces([])
      setMemberships([])
      setActiveWorkspaceId(null)
      localStorage.removeItem(activeWorkspaceStorageKey)
      return
    }

    const client = requireSupabaseAuth()
    setWorkspaceLoading(true)
    setError(null)
    try {
      const [{ data: workspaceRows, error: workspaceError }, { data: memberRows, error: memberError }] = await Promise.all([
        client.from('workspaces').select('id, name').order('name', { ascending: true }),
        client.from('memberships').select('workspace_id, user_id, role').order('workspace_id', { ascending: true }),
      ])

      if (workspaceError) {
        throw workspaceError
      }

      if (memberError) {
        throw memberError
      }

      const nextWorkspaces = (workspaceRows ?? []) as Workspace[]
      setWorkspaces(nextWorkspaces)
      setMemberships((memberRows ?? []) as WorkspaceMember[])

      const storedWorkspace = localStorage.getItem(activeWorkspaceStorageKey)
      const nextActiveWorkspace = nextWorkspaces.find((workspace) => workspace.id === storedWorkspace) ?? nextWorkspaces[0] ?? null
      if (nextActiveWorkspace) {
        selectWorkspace(nextActiveWorkspace.id)
      } else {
        setActiveWorkspaceId(null)
        localStorage.removeItem(activeWorkspaceStorageKey)
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Não foi possível carregar os workspaces.'
      setError(message)
      throw caughtError
    } finally {
      setWorkspaceLoading(false)
    }
  }, [selectWorkspace, session])

  useEffect(() => {
    let client: ReturnType<typeof requireSupabaseAuth>
    try {
      client = requireSupabaseAuth()
    } catch {
      setError(supabasePreviewConfigErrorMessage)
      setAuthLoading(false)
      setAuthReady(true)
      return
    }

    let mounted = true
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) {
        return
      }

      if (sessionError) {
        setError(sessionError.message)
      }

      setSession(data.session)
      setAuthLoading(false)
      setAuthReady(true)
    })

    const { data: subscription } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
    })

    return () => {
      mounted = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!authReady) {
      return
    }

    void refreshWorkspaces().catch(() => undefined)
  }, [authReady, refreshWorkspaces])

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    setError(null)
    try {
      const client = requireSupabaseAuth()
      const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) {
        setError(signInError.message)
        throw signInError
      }
    } catch (caughtError) {
      const fallback = caughtError instanceof Error ? caughtError.message : 'Não foi possível autenticar.'
      const message = getSupabaseAuthErrorMessage(caughtError, fallback)
      setError(message)
      throw new Error(message)
    }
  }, [])

  const signUpWithPassword = useCallback(async (email: string, password: string) => {
    setError(null)
    try {
      const client = requireSupabaseAuth()
      const { error: signUpError } = await client.auth.signUp({ email: email.trim(), password })
      if (signUpError) {
        setError(signUpError.message)
        throw signUpError
      }
    } catch (caughtError) {
      const fallback = caughtError instanceof Error ? caughtError.message : 'Não foi possível autenticar.'
      const message = getSupabaseAuthErrorMessage(caughtError, fallback)
      setError(message)
      throw new Error(message)
    }
  }, [])

  const signOut = useCallback(async () => {
    setError(null)
    try {
      const client = requireSupabaseAuth()
      const { error: signOutError } = await client.auth.signOut()
      if (signOutError) {
        setError(signOutError.message)
        throw signOutError
      }
    } catch (caughtError) {
      const fallback = caughtError instanceof Error ? caughtError.message : 'Não foi possível sair.'
      const message = getSupabaseAuthErrorMessage(caughtError, fallback)
      setError(message)
      throw new Error(message)
    }

    setWorkspaces([])
    setMemberships([])
    setActiveWorkspaceId(null)
    localStorage.removeItem(activeWorkspaceStorageKey)
  }, [])

  const createWorkspace = useCallback(async (name: string) => {
    const workspaceName = name.trim()
    if (!workspaceName) {
      throw new Error('Informe o nome do workspace.')
    }

    setError(null)
    try {
      const client = requireSupabaseAuth()
      const { data, error: createError } = await client.rpc('create_workspace', { workspace_name: workspaceName })
      if (createError) {
        setError(createError.message)
        throw createError
      }

      const createdWorkspace = data as Workspace
      await refreshWorkspaces()
      selectWorkspace(createdWorkspace.id)
      return createdWorkspace
    } catch (caughtError) {
      const fallback = caughtError instanceof Error ? caughtError.message : 'Não foi possível criar o workspace.'
      const message = getSupabaseAuthErrorMessage(caughtError, fallback)
      setError(message)
      throw new Error(message)
    }
  }, [refreshWorkspaces, selectWorkspace])

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  )

  const activeMembership = useMemo(
    () => memberships.find((membership) => membership.workspace_id === activeWorkspace?.id && membership.user_id === user?.id) ?? null,
    [activeWorkspace?.id, memberships, user?.id],
  )

  const value = useMemo<AuthWorkspaceContextValue>(() => ({
    activeMembership,
    activeWorkspace,
    authReady,
    createWorkspace,
    error,
    isConfigured: hasSupabaseConfig,
    loading: authLoading || workspaceLoading,
    memberships,
    refreshWorkspaces,
    selectWorkspace,
    session,
    signInWithPassword,
    signOut,
    signUpWithPassword,
    user,
    workspaces,
  }), [
    activeMembership,
    activeWorkspace,
    authLoading,
    authReady,
    createWorkspace,
    error,
    memberships,
    refreshWorkspaces,
    selectWorkspace,
    session,
    signInWithPassword,
    signOut,
    signUpWithPassword,
    user,
    workspaceLoading,
    workspaces,
  ])

  return <AuthWorkspaceContext.Provider value={value}>{children}</AuthWorkspaceContext.Provider>
}
