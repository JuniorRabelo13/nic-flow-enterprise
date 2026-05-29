import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { type Session } from '@supabase/supabase-js'
import { hasSupabaseConfig, supabase } from '../whatsapp/services/supabase.client'
import { AuthWorkspaceContext, type AuthWorkspaceContextValue, type Workspace, type WorkspaceMember } from './authWorkspaceContext'

const activeWorkspaceStorageKey = 'nic.activeWorkspaceId'

const requireSupabase = () => {
  if (!supabase) {
    throw new Error('Supabase is not configured')
  }

  return supabase
}

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

    const client = requireSupabase()
    setWorkspaceLoading(true)
    setError(null)
    try {
      const [{ data: workspaceRows, error: workspaceError }, { data: memberRows, error: memberError }] = await Promise.all([
        client.from('workspaces').select('id, name, created_by, created_at, updated_at').order('created_at', { ascending: true }),
        client.from('workspace_members').select('workspace_id, user_id, role, created_at, updated_at').order('created_at', { ascending: true }),
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
    if (!supabase) {
      setAuthLoading(false)
      setAuthReady(true)
      return
    }

    let mounted = true
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
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

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
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
    const client = requireSupabase()
    setError(null)
    const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password })
    if (signInError) {
      setError(signInError.message)
      throw signInError
    }
  }, [])

  const signUpWithPassword = useCallback(async (email: string, password: string) => {
    const client = requireSupabase()
    setError(null)
    const { error: signUpError } = await client.auth.signUp({ email: email.trim(), password })
    if (signUpError) {
      setError(signUpError.message)
      throw signUpError
    }
  }, [])

  const signOut = useCallback(async () => {
    const client = requireSupabase()
    setError(null)
    const { error: signOutError } = await client.auth.signOut()
    if (signOutError) {
      setError(signOutError.message)
      throw signOutError
    }

    setWorkspaces([])
    setMemberships([])
    setActiveWorkspaceId(null)
    localStorage.removeItem(activeWorkspaceStorageKey)
  }, [])

  const createWorkspace = useCallback(async (name: string) => {
    const client = requireSupabase()
    const workspaceName = name.trim()
    if (!workspaceName) {
      throw new Error('Informe o nome do workspace.')
    }

    setError(null)
    const { data, error: createError } = await client.rpc('create_workspace', { workspace_name: workspaceName })
    if (createError) {
      setError(createError.message)
      throw createError
    }

    const createdWorkspace = data as Workspace
    await refreshWorkspaces()
    selectWorkspace(createdWorkspace.id)
    return createdWorkspace
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
