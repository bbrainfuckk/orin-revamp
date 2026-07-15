import {
  Bot,
  ChartNoAxesCombined,
  ChevronDown,
  ContactRound,
  Inbox,
  LayoutDashboard,
  Network,
  Settings,
  Workflow,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const navigation = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/agents', label: 'AI agents', icon: Bot },
  { to: '/app/inbox', label: 'Inbox', icon: Inbox },
  { to: '/app/contacts', label: 'Contacts', icon: ContactRound },
  { to: '/app/automations', label: 'Automations', icon: Workflow },
  { to: '/app/integrations', label: 'Integrations', icon: Network },
  { to: '/app/analytics', label: 'Analytics', icon: ChartNoAxesCombined },
];

export function WorkspaceShell() {
  const { signOut, user, workspace } = useAuth();
  const initial = (user?.displayName || user?.email || 'O').trim().charAt(0).toUpperCase();

  return (
    <main className="workspace-app">
      <aside className="workspace-sidebar">
        <NavLink className="workspace-brand" to="/app">
          <img src="/assets/brand/orin-mascot-original.webp" alt="" />
          <span><strong>ORIN AI</strong><small>Workspace</small></span>
        </NavLink>

        <div className="workspace-switcher">
          <span className="workspace-switcher__mark">O</span>
          <span><strong>{workspace?.name || 'My workspace'}</strong><small>Owner</small></span>
          <ChevronDown aria-hidden="true" />
        </div>

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
          <span className="workspace-topbar__status"><i /> Workspace private</span>
        </header>
        <div className="workspace-content"><Outlet /></div>
      </section>
    </main>
  );
}
