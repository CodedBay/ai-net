import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from './i18n'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider } from './context/ToastContext'
import { ThemeProvider } from './context/ThemeContext'
import { NotFoundPage } from './pages/NotFoundPage'
import ServerErrorPage from './pages/ServerErrorPage'
import ForbiddenPage from './pages/ForbiddenPage'
import AppShell from './components/layout/AppShell'
import LandingPage from './pages/LandingPage'
import ErrorBoundary, { RouteErrorBoundary } from './components/common/ErrorBoundary'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { CommandPalette } from './components/common/CommandPalette'
import RouteLoader from './components/common/RouteLoader'
import { useCommandPalette } from './hooks/useCommandPalette'
import OnboardingModal from './components/onboarding/OnboardingModal'
import './components/common/Toast.css'
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'))
const DashboardPage = lazy(() =>
  import('./pages/dashboard').then((module) => ({ default: module.DashboardPage })),
)
const WalletPage = lazy(() => import('./pages/WalletPage'))
const AgentsPage = lazy(() => import('./pages/AgentsPage'))
const NewTaskPage = lazy(() => import('./pages/tasks/NewTaskPage'))
const TaskHistoryPage = lazy(() => import('./pages/tasks/TaskHistoryPage'))
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'))
const RendererDemoPage = lazy(() => import('./pages/RendererDemoPage'))

const RouteLoadingFallback = () => <RouteLoader />

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})

// Lazy-loaded page components
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage'))

// Lives INSIDE <Router> and the theme/wallet providers: useCommandPalette()
// calls useNavigate(), useTheme() and useWallet(), which all require their
// context providers to be mounted above this component.
const RoutedContent: React.FC = () => {
  const { isOpen, closePalette, commands } = useCommandPalette()

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/*"
          element={
            <AppShell>
              <Suspense fallback={<RouteLoadingFallback />}>
                <Routes>
                  <Route
                    path="/dashboard"
                    element={
                      <RouteErrorBoundary label="Dashboard">
                        <ProtectedRoute>
                          <DashboardPage />
                        </ProtectedRoute>
                      </RouteErrorBoundary>
                    }
                  />
                  <Route
                    path="/wallet"
                    element={
                      <RouteErrorBoundary label="Wallet">
                        <ProtectedRoute>
                          <WalletPage />
                        </ProtectedRoute>
                      </RouteErrorBoundary>
                    }
                  />
                  <Route
                    path="/payments"
                    element={
                      <ProtectedRoute>
                        <PaymentsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="/marketplace" element={<Navigate to="/agents" replace />} />
                  <Route path="/tasks" element={<Navigate to="/tasks/history" replace />} />
                  <Route
                    path="/notifications"
                    element={
                      <ProtectedRoute>
                        <NotificationsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/agents"
                    element={
                      <RouteErrorBoundary label="Agents">
                        <ProtectedRoute>
                          <AgentsPage />
                        </ProtectedRoute>
                      </RouteErrorBoundary>
                    }
                  />
                  <Route path="/forbidden" element={<ForbiddenPage />} />
                  <Route path="/server-error" element={<ServerErrorPage />} />
                  <Route
                    path="/agents/:id"
                    element={
                      <ProtectedRoute>
                        <AgentDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/tasks/new"
                    element={
                      <RouteErrorBoundary label="New Task">
                        <ProtectedRoute>
                          <NewTaskPage />
                        </ProtectedRoute>
                      </RouteErrorBoundary>
                    }
                  />
                  <Route
                    path="/tasks/history"
                    element={
                      <RouteErrorBoundary label="Task History">
                        <ProtectedRoute>
                          <TaskHistoryPage />
                        </ProtectedRoute>
                      </RouteErrorBoundary>
                    }
                  />
                  <Route
                    path="/tasks/:id"
                    element={
                      <RouteErrorBoundary label="Task Detail">
                        <ProtectedRoute>
                          <TaskDetailPage />
                        </ProtectedRoute>
                      </RouteErrorBoundary>
                    }
                  />
                  {import.meta.env.DEV && (
                    <Route path="/renderer-demo" element={<RendererDemoPage />} />
                  )}
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </AppShell>
          }
        />
      </Routes>

      <CommandPalette
        isOpen={isOpen}
        onClose={closePalette}
        commands={commands}
      />

      {/* Onboarding modal — shown to first-time users, skippable, dismissable (#99) */}
      <OnboardingModal />
    </>
  )
}

const App: React.FC = () => {
  return (
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <WalletProvider>
              <ToastProvider>
                <Router>
                  <RoutedContent />
                </Router>
              </ToastProvider>
            </WalletProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </I18nextProvider>
  )
}

export default App
