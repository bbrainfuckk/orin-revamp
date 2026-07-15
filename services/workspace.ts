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
  role: 'owner';
};

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

  await setDoc(memberRef, {
    userId: user.uid,
    role: 'owner',
    joinedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });

  const workspace = await getDoc(workspaceRef);
  return {
    id: workspaceId,
    name: typeof workspace.data()?.name === 'string' ? workspace.data()!.name : `${firstName(user)}'s workspace`,
    role: 'owner',
  };
}
