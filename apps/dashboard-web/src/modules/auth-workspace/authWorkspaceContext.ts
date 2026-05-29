import { createContext, useContext } from 'react'
import { type Session, type User } from '@supabase/supabase-js'

export type WorkspaceRole = 'owner' | 'admin' | 'member'

export type Workspace = {
  id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export type WorkspaceMember = {
  workspace_id: string
  user_id: string
  role: WorkspaceRole
  created_at: string
  updated_at: string
}

export type AuthWorkspaceContextValue = {
  activeMembership: WorkspaceMember | null
  activeWorkspace: Workspace | null
  authReady: boolean
  createWorkspace: (name: string) => Promise<Workspace>
  error: string | null
  isConfigured: boolean
  loading: boolean
  memberships: WorkspaceMember[]
  refreshWorkspaces: () => Promise<void>
  selectWorkspace: (workspaceId: string) => void
  session: Session | null
  signInWithPassword: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  signUpWithPassword: (email: string, password: string) => Promise<void>
  user: User | null
  workspaces: Workspace[]
}

export const AuthWorkspaceContext = createContext<AuthWorkspaceContextValue | null>(null)

export const useAuthWorkspace = () => {
  const context = useContext(AuthWorkspaceContext)
  if (!context) {
    throw new Error('useAuthWorkspace must be used within AuthWorkspaceProvider')
  }

  return context
}
