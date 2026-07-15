import type { User } from 'firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

export type WorkspaceIdentity = {
  id: string;
  name: string;
  role: WorkspaceRole;
  plan?: string;
};

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';

function firstName(user: User) {
  return user.displayName?.trim().split(/\s+/)[0] || 'My';
}

export async function ensurePersonalWorkspace(db: Firestore, user: User): Promise<WorkspaceIdentity> {
  const workspaceId = `personal_${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  const workspaceRef = doc(db, 'workspaces', workspaceId);
  const memberRef = doc(db, 'workspaces', workspaceId, 'members', user.uid);

  const userSnapshot = await getDoc(userRef);
  await setDoc(userRef, {
    displayName: user.displayName || '',
    email: user.email || '',
    photoURL: user.photoURL || '',
    defaultWorkspaceId: workspaceId,
    updatedAt: serverTimestamp(),
    ...(!userSnapshot.exists() ? { createdAt: serverTimestamp() } : {}),
  }, { merge: true });

  // These writes are deliberately sequential. The membership rule verifies the
  // owner against the workspace document created immediately before it.
  const workspaceSnapshot = await getDoc(workspaceRef).catch(() => null);
  if (!workspaceSnapshot?.exists()) {
    await setDoc(workspaceRef, {
      name: `${firstName(user)}'s workspace`,
      ownerId: user.uid,
      plan: 'starter',
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const memberSnapshot = await getDoc(memberRef).catch(() => null);
  if (!memberSnapshot?.exists()) {
    await setDoc(memberRef, {
      userId: user.uid,
      role: 'owner',
      joinedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const workspace = await getDoc(workspaceRef);
  return {
    id: workspaceId,
    name: typeof workspace.data()?.name === 'string' ? workspace.data()!.name : `${firstName(user)}'s workspace`,
    role: 'owner',
  };
}

export async function loadAccessibleWorkspaces(user: User, fallback: WorkspaceIdentity): Promise<WorkspaceIdentity[]> {
  const response = await fetch('/api/widget/message', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await user.getIdToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'team_access', action: 'list_workspaces' }),
  });
  const payload = await response.json().catch(() => ({})) as { workspaces?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error || 'Your workspaces could not be loaded.');
  const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces.flatMap((workspace): WorkspaceIdentity[] => {
    if (!workspace || typeof workspace !== 'object') return [];
    const value = workspace as { id?: unknown; name?: unknown; role?: unknown; plan?: unknown };
    if (
      typeof value.id !== 'string'
      || typeof value.name !== 'string'
      || !['owner', 'admin', 'editor', 'viewer'].includes(String(value.role))
    ) return [];
    return [{
      id: value.id,
      name: value.name,
      role: value.role as WorkspaceRole,
      ...(typeof value.plan === 'string' ? { plan: value.plan } : {}),
    }];
  }) : [];
  return workspaces.some((workspace) => workspace.id === fallback.id) ? workspaces : [fallback, ...workspaces];
}
