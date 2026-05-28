import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger } from './logger'
import { sentry } from './sentry'

type Props = {
  children: ReactNode
}

type State = {
  failed: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error('react_render_error', { error: error.message, componentStack: info.componentStack })
    sentry.captureException(error, { componentStack: info.componentStack })
  }

  render() {
    if (this.state.failed) {
      return <div role="alert">Não foi possível carregar esta tela.</div>
    }

    return this.props.children
  }
}
