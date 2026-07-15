import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth, db, firebaseConfigured, googleProvider } from '../services/firebase';
import { ensurePersonalWorkspace, type WorkspaceIdentity } from '../services/workspace';

type AuthContextValue = {
  configured: boolean;
  error: string;
  loading: boolean;
  user: User | null;
  workspace: WorkspaceIdentity | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(firebaseConfigured);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceIdentity | null>(null);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }

    let active = true;
    const unsubscribe = onAuthStateChanged(
      auth,
      async (nextUser) => {
        if (!active) return;
        setUser(nextUser);
        setWorkspace(null);

        if (!nextUser) {
          setLoading(false);
          return;
        }

        if (!db) {
          setError('The ORIN AI workspace database is not configured.');
          setLoading(false);
          return;
        }

        setLoading(true);
        try {
          const nextWorkspace = await ensurePersonalWorkspace(db, nextUser);
          if (!active) return;
          setWorkspace(nextWorkspace);
          setError('');
        } catch (cause) {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : 'Your workspace could not be prepared.');
        } finally {
          if (active) setLoading(false);
        }
      },
      (cause) => {
        if (!active) return;
        setError(cause.message);
        setLoading(false);
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    configured: firebaseConfigured,
    error,
    loading,
    user,
    workspace,
    signInWithGoogle: async () => {
      if (!auth) throw new Error('Firebase is not configured for this environment.');
      setError('');
      await signInWithPopup(auth, googleProvider);
    },
    signOut: async () => {
      if (auth) await firebaseSignOut(auth);
    },
  }), [error, loading, user, workspace]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
