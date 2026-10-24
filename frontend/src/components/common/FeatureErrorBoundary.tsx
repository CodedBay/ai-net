import { Component, createRef, type ErrorInfo, type ReactNode } from 'react'
import styles from './FeatureErrorBoundary.module.css'

interface Props {
  featureName: string
  children: ReactNode
}

interface State {
  error: Error | null
  hasError: boolean
}

export class FeatureErrorBoundary extends Component<Props, State> {
  private readonly fallbackRef = createRef<HTMLDivElement>()

  public state: State = { error: null, hasError: false }

  public static getDerivedStateFromError(error: Error): State {
    return { error, hasError: true }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error(`FeatureErrorBoundary caught an error in ${this.props.featureName}:`, error, errorInfo)
    }
  }

  public componentDidUpdate(_previousProps: Props, previousState: State): void {
    if (!previousState.hasError && this.state.hasError) {
      this.fallbackRef.current?.focus()
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null, hasError: false })
  }

  private getReportIssueUrl(): string {
    const url = new URL('https://github.com/CodedSceptre/ai-net/issues/new')
    url.searchParams.set('title', `Bug: ${this.props.featureName} failed`)
    url.searchParams.set(
      'body',
      `## What happened?\nThe ${this.props.featureName} section encountered an unexpected error.\n\n## Error message\n${this.state.error?.message ?? 'Unknown error'}`,
    )
    return url.toString()
  }

  public render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    const message = import.meta.env.DEV
      ? this.state.error?.message || 'An unexpected error occurred.'
      : 'This section could not be loaded. Please try again.'

    return (
      <div
        className={styles.card}
        role="alert"
        aria-live="assertive"
        aria-labelledby="feature-error-title"
        tabIndex={-1}
        ref={this.fallbackRef}
      >
        <div>
          <h2 id="feature-error-title" className={styles.title}>{this.props.featureName} is unavailable</h2>
          <p className={styles.message}>{message}</p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.retry} onClick={this.retry}>
            Retry
          </button>
          <a className={styles.report} href={this.getReportIssueUrl()} target="_blank" rel="noreferrer">
            Report Issue
          </a>
        </div>
      </div>
    )
  }
}

export default FeatureErrorBoundary