import {
  Bell,
  Bot,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ContactRound,
  Inbox,
  LayoutDashboard,
  Network,
  Send,
  ShoppingBag,
  Volume2,
  Settings,
  Workflow,
} from 'lucide-react';
import { collection, limit, onSnapshot, query, where, type Timestamp } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

const navigation = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/agents', label: 'AI agents', icon: Bot },
  { to: '/app/inbox', label: 'Inbox', icon: Inbox },
  { to: '/app/contacts', label: 'Contacts', icon: ContactRound },
  { to: '/app/automations', label: 'Automations', icon: Workflow },
  { to: '/app/publishing', label: 'Publishing', icon: Send },
  { to: '/app/communications', label: 'Voice & SMS', icon: Volume2 },
  { to: '/app/commerce', label: 'Commerce', icon: ShoppingBag },
  { to: '/app/integrations', label: 'Integrations', icon: Network },
  { to: '/app/analytics', label: 'Analytics', icon: ChartNoAxesCombined },
];

type WorkspaceNotification = {
  id: string;
  title: string;
  body: string;
  status: 'unread' | 'read';
  createdAt?: Timestamp;
};

function requestId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `workspace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function roleLabel(role: string | undefined) {
  return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : 'Member';
}

export function WorkspaceShell() {
  const { signOut, switchWorkspace, user, workspace, workspaces } = useAuth();
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<WorkspaceNotification[]>([]);
  const initial = (user?.displayName || user?.email || 'O').trim().charAt(0).toUpperCase();
  const unreadCount = notifications.filter((notification) => notification.status === 'unread').length;

  useEffect(() => {
    if (!db || !user || !workspace) {
      setNotifications([]);
      return undefined;
    }
    return onSnapshot(
      query(collection(db, 'workspaces', workspace.id, 'notifications'), where('recipientId', '==', user.uid), limit(30)),
      (snapshot) => setNotifications(snapshot.docs.map((notification) => ({
        id: notification.id,
        title: typeof notification.data().title === 'string' ? notification.data().title : 'ORIN AI notification',
        body: typeof notification.data().body === 'string' ? notification.data().body : '',
        status: notification.data().status === 'read' ? 'read' as const : 'unread' as const,
        createdAt: notification.data().createdAt as Timestamp | undefined,
      })).sort((left, right) => (right.createdAt?.toMillis() || 0) - (left.createdAt?.toMillis() || 0))),
      () => setNotifications([]),
    );
  }, [user, workspace]);

  const markNotificationRead = async (notification: WorkspaceNotification) => {
    if (!user || !workspace || notification.status === 'read') return;
    const response = await fetch('/api/widget/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'team_access',
        action: 'mark_notification_read',
        workspaceId: workspace.id,
        notificationId: notification.id,
        requestId: requestId(),
      }),
    });
    if (!response.ok) return;
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, status: 'read' } : item));
  };

  return (
    <main className="workspace-app">
      <aside className="workspace-sidebar">
        <NavLink className="workspace-brand" to="/app">
          <img src="/assets/brand/orin-mascot-original.webp" alt="" />
          <span><strong>ORIN AI</strong><small>Workspace</small></span>
        </NavLink>

        <button type="button" className="workspace-switcher" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}>
          <span className="workspace-switcher__mark">O</span>
          <span><strong>{workspace?.name || 'My workspace'}</strong><small>{roleLabel(workspace?.role)}</small></span>
          <ChevronDown aria-hidden="true" />
        </button>
        {workspaceMenuOpen && <div className="workspace-switcher-menu" aria-label="Available workspaces">
          {workspaces.map((candidate) => <button type="button" key={candidate.id} className={candidate.id === workspace?.id ? 'is-active' : ''} onClick={() => { switchWorkspace(candidate.id); setWorkspaceMenuOpen(false); }}>
            <span>{candidate.name.charAt(0).toUpperCase()}</span>
            <span><strong>{candidate.name}</strong><small>{roleLabel(candidate.role)}</small></span>
            {candidate.id === workspace?.id && <Check aria-hidden="true" />}
          </button>)}
        </div>}

        <nav className="workspace-nav" aria-label="Workspace navigation">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'is-active' : ''}>
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="workspace-sidebar__bottom">
          <NavLink to="/app/settings" className={({ isActive }) => isActive ? 'is-active' : ''}>
            <Settings aria-hidden="true" />
            <span>Settings</span>
          </NavLink>
          <button type="button" className="workspace-user" onClick={() => signOut()}>
            {user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : <span>{initial}</span>}
            <span><strong>{user?.displayName || 'ORIN AI user'}</strong><small>Sign out</small></span>
          </button>
        </div>
      </aside>

      <section className="workspace-main">
        <header className="workspace-topbar">
          <span>ORIN AI workspace</span>
          <div className="workspace-topbar__actions">
            <button type="button" className="workspace-topbar__workspace" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}><span>{workspace?.name || 'Workspace'}</span><ChevronDown aria-hidden="true" /></button>
            <button type="button" className="workspace-notification-button" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`} aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}>
              <Bell aria-hidden="true" />{unreadCount > 0 && <small>{Math.min(unreadCount, 9)}</small>}
            </button>
            <span className="workspace-topbar__status"><i /> Workspace private</span>
          </div>
          {workspaceMenuOpen && <div className="workspace-mobile-menu" aria-label="Available workspaces">{workspaces.map((candidate) => <button type="button" key={candidate.id} className={candidate.id === workspace?.id ? 'is-active' : ''} onClick={() => { switchWorkspace(candidate.id); setWorkspaceMenuOpen(false); }}><span><strong>{candidate.name}</strong><small>{roleLabel(candidate.role)}</small></span>{candidate.id === workspace?.id && <Check aria-hidden="true" />}</button>)}</div>}
          {notificationsOpen && <section className="workspace-notifications" aria-label="Notifications">
            <header><div><span>Team alerts</span><strong>Notifications</strong></div><small>{unreadCount} unread</small></header>
            {notifications.length ? notifications.slice(0, 12).map((notification) => <button type="button" key={notification.id} className={`is-${notification.status}`} onClick={() => void markNotificationRead(notification)}>
              <span><Bell aria-hidden="true" /></span>
              <span><strong>{notification.title}</strong><small>{notification.body}</small><time>{notification.createdAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Just now'}</time></span>
              {notification.status === 'unread' && <i />}
            </button>) : <p>No notifications yet.</p>}
          </section>}
        </header>
        <div className="workspace-content"><Outlet /></div>
      </section>
    </main>
  );
}
