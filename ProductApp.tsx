import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import './workspace/workspace.css';

const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const WorkspaceShell = lazy(() => import('./workspace/WorkspaceShell').then((module) => ({ default: module.WorkspaceShell })));
const AgentStudio = lazy(() => import('./workspace/AgentStudio').then((module) => ({ default: module.AgentStudio })));
const InboxPage = lazy(() => import('./workspace/InboxPage').then((module) => ({ default: module.InboxPage })));
const ContactsPage = lazy(() => import('./workspace/ContactsPage').then((module) => ({ default: module.ContactsPage })));
const AutomationsPage = lazy(() => import('./workspace/AutomationsPage').then((module) => ({ default: module.AutomationsPage })));
const AnalyticsPage = lazy(() => import('./workspace/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })));
const PublishingPage = lazy(() => import('./workspace/PublishingPage').then((module) => ({ default: module.PublishingPage })));
const CommunicationsPage = lazy(() => import('./workspace/CommunicationsPage').then((module) => ({ default: module.CommunicationsPage })));
const CommercePage = lazy(() => import('./workspace/CommercePage').then((module) => ({ default: module.CommercePage })));
const DocumentationPage = lazy(() => import('./workspace/DocumentationPage').then((module) => ({ default: module.DocumentationPage })));
const loadPages = () => import('./workspace/pages');
const OverviewPage = lazy(() => loadPages().then((module) => ({ default: module.OverviewPage })));
const AgentsPage = lazy(() => loadPages().then((module) => ({ default: module.AgentsPage })));
const IntegrationsPage = lazy(() => loadPages().then((module) => ({ default: module.IntegrationsPage })));
const SettingsPage = lazy(() => loadPages().then((module) => ({ default: module.SettingsPage })));
const WidgetPage = lazy(() => import('./workspace/WidgetPage').then((module) => ({ default: module.WidgetPage })));

function RequireAuth() {
  const { error, loading, user, workspace } = useAuth();
  const location = useLocation();

  if (loading) return <div className="workspace-loading">Opening your ORIN AI workspace…</div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!workspace) return <div className="workspace-loading workspace-loading--error"><strong>We couldn't open your workspace.</strong><span>{error || 'Please sign out and try again.'}</span></div>;
  return <WorkspaceShell />;
}

function PaymentCompletePage() {
  const [params] = useSearchParams();
  const cancelled = params.get('status') === 'cancelled';
  const reference = params.get('order') || 'your order';
  return <main className="payment-return"><span>{cancelled ? 'Payment not completed' : 'Payment submitted'}</span><h1>{cancelled ? 'Nothing was charged.' : 'ORIN AI is verifying it.'}</h1><p>{cancelled ? `${reference} remains unpaid.` : `${reference} will be marked paid only after PayMongo confirms the transaction.`}</p><strong>You may close this page and return to Messenger.</strong></main>;
}

export function ProductApp() {
  return (
    <AuthProvider>
      <Suspense fallback={<div className="workspace-loading">Opening your workspace…</div>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/widget/:widgetKey" element={<WidgetPage />} />
          <Route path="/payment/complete" element={<PaymentCompletePage />} />
          <Route path="/app" element={<RequireAuth />}>
            <Route index element={<OverviewPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/new" element={<AgentStudio />} />
            <Route path="agents/:agentId" element={<AgentStudio />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="contacts" element={<ContactsPage />} />
            <Route path="automations" element={<AutomationsPage />} />
            <Route path="publishing" element={<PublishingPage />} />
            <Route path="communications" element={<CommunicationsPage />} />
            <Route path="commerce" element={<CommercePage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="docs" element={<DocumentationPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
