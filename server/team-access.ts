import {
  commitWrites,
  documentName,
  fieldString,
  getDocument,
  googleAccessToken,
  integerValue,
  stableId,
  stringValue,
  timestampValue,
  verifyFirebaseAccount,
  type FirebaseAccount,
  type FirestoreDocument,
  type ServerRequest,
} from './server-data.js';
import { connectVerifiedWebhook, disconnectVerifiedWebhook } from './webhook-connector.js';

type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';
const BOOTSTRAP_OWNER_EMAIL = 'msarvillan@gmail.com';

export type TeamAccessBody = {
  action?: unknown;
  workspaceId?: unknown;
  email?: unknown;
  role?: unknown;
  targetUserId?: unknown;
  invitationId?: unknown;
  notificationId?: unknown;
  requestId?: unknown;
  displayName?: unknown;
  webhookUrl?: unknown;
};

type FirestoreList = { documents?: FirestoreDocument[]; nextPageToken?: string };
type FirestoreQueryResult = { document?: FirestoreDocument };

const teamRoles = new Set<TeamRole>(['owner', 'admin', 'editor', 'viewer']);
const inviteRoles = new Set<TeamRole>(['admin', 'editor', 'viewer']);
const editableRoles = new Set<TeamRole>(['admin', 'editor', 'viewer']);

function clean(value: unknown, maximum: number) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum)
    : '';
}

function normalizeEmail(value: unknown) {
  const email = clean(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validWorkspaceId(value: string) {
  return /^[A-Za-z0-9_-]{8,200}$/.test(value);
}

function validUserId(value: string) {
  return /^[A-Za-z0-9_-]{8,200}$/.test(value);
}

function encodedPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function listDocuments(projectId: string, accessToken: string, path: string, maximum = 100) {
  const documents: FirestoreDocument[] = [];
  let pageToken = '';
  while (documents.length < maximum) {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`);
    url.searchParams.set('pageSize', String(Math.min(100, maximum - documents.length)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return documents;
    if (!response.ok) throw new Error('SERVER_STORAGE_READ_FAILED');
    const payload = (await response.json()) as FirestoreList;
    documents.push(...(payload.documents || []));
    pageToken = payload.nextPageToken || '';
    if (!pageToken) break;
  }
  return documents;
}

async function queryRootCollection(projectId: string, accessToken: string, collectionId: string, fieldPath: string, value: string, limit = 50) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: { stringValue: value } } },
        limit: Math.min(100, Math.max(1, limit)),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('SERVER_STORAGE_READ_FAILED');
  return ((await response.json()) as FirestoreQueryResult[]).flatMap((entry) => entry.document ? [entry.document] : []);
}

function memberRole(document: FirestoreDocument | null): TeamRole | '' {
  const role = fieldString(document, 'role') as TeamRole;
  return teamRoles.has(role) ? role : '';
}

function displayName(account: FirebaseAccount) {
  return clean(account.displayName, 100) || normalizeEmail(account.email).split('@')[0] || 'Team member';
}

function memberFields(account: FirebaseAccount, role: TeamRole, now: string) {
  return {
    userId: stringValue(account.localId),
    role: stringValue(role),
    displayName: stringValue(displayName(account)),
    email: stringValue(normalizeEmail(account.email)),
    emailLower: stringValue(normalizeEmail(account.email)),
    photoURL: stringValue(clean(account.photoUrl, 500)),
    updatedAt: timestampValue(now),
  };
}

async function requireMembership(projectId: string, accessToken: string, workspaceId: string, uid: string) {
  if (!validWorkspaceId(workspaceId)) throw new Error('INVALID_REQUEST');
  const [workspace, membership] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`),
  ]);
  const role = memberRole(membership);
  if (!workspace || !membership || !role) throw new Error('FORBIDDEN');
  return { workspace, membership, role, ownerId: fieldString(workspace, 'ownerId') };
}

async function reserveTeamRate(projectId: string, accessToken: string, workspaceId: string, uid: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const bucketId = await stableId('team-admin-rate', workspaceId, uid, String(minute));
  const path = `outboundRateLimits/team_${bucketId}`;
  const created = await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, path), fields: {
      count: integerValue(1),
      expiresAt: timestampValue(new Date((minute + 3) * 60_000).toISOString()),
    } },
    currentDocument: { exists: false },
  }], true);
  if (created) return;
  const existing = await getDocument(projectId, accessToken, path);
  if (Number(existing?.fields?.count?.integerValue || 0) >= 30) throw new Error('TEAM_RATE_LIMIT');
  await commitWrites(projectId, accessToken, [{
    transform: { document: documentName(projectId, path), fieldTransforms: [{ fieldPath: 'count', increment: integerValue(1) }] },
    currentDocument: { exists: true },
  }]);
}

async function mutationReservation(projectId: string, workspaceId: string, uid: string, action: string, requestId: string) {
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) throw new Error('INVALID_REQUEST');
  const mutationId = await stableId('team-mutation', workspaceId, uid, action, requestId);
  return {
    path: `outboundRequests/team_${mutationId}`,
    write: {
      update: { name: documentName(projectId, `outboundRequests/team_${mutationId}`), fields: {
        provider: stringValue('team'),
        workspaceIdHash: stringValue((await stableId('workspace', workspaceId)).slice(0, 24)),
        actorUserId: stringValue(uid),
        action: stringValue(action),
        state: stringValue('applied'),
        createdAt: timestampValue(new Date().toISOString()),
      } },
      currentDocument: { exists: false },
    },
  };
}

async function commitTeamMutation(projectId: string, accessToken: string, reservation: Awaited<ReturnType<typeof mutationReservation>>, writes: unknown[]) {
  const accepted = await commitWrites(projectId, accessToken, [reservation.write, ...writes], true);
  if (accepted) return { duplicate: false };
  if (await getDocument(projectId, accessToken, reservation.path)) return { duplicate: true };
  throw new Error('TEAM_UPDATE_CONFLICT');
}

async function acceptPendingInvitations(projectId: string, accessToken: string, account: FirebaseAccount) {
  const email = normalizeEmail(account.email);
  if (!email || account.emailVerified !== true) return;
  const invitations = await queryRootCollection(projectId, accessToken, 'workspaceInvitations', 'emailLower', email, 20);
  const now = new Date();
  for (const invitation of invitations) {
    if (fieldString(invitation, 'status') !== 'pending') continue;
    const expiresAt = new Date(fieldString(invitation, 'expiresAt')).getTime();
    const workspaceId = fieldString(invitation, 'workspaceId');
    const invitedRole = fieldString(invitation, 'role') as TeamRole;
    if (!validWorkspaceId(workspaceId) || !inviteRoles.has(invitedRole) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) continue;
    const [workspace, existingMembership] = await Promise.all([
      getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
      getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${account.localId}`),
    ]);
    if (!workspace) continue;
    const existingRole = memberRole(existingMembership);
    const role = existingRole || invitedRole;
    const acceptedAt = now.toISOString();
    const mirrorId = await stableId('user-workspace', account.localId, workspaceId);
    const writes: unknown[] = [
      {
        update: { name: documentName(projectId, `workspaces/${workspaceId}/members/${account.localId}`), fields: {
          ...memberFields(account, role, acceptedAt),
          joinedAt: timestampValue(fieldString(existingMembership, 'joinedAt') || acceptedAt),
        } },
      },
      {
        update: { name: documentName(projectId, `userWorkspaceMemberships/${mirrorId}`), fields: {
          userId: stringValue(account.localId),
          workspaceId: stringValue(workspaceId),
          role: stringValue(role),
          updatedAt: timestampValue(acceptedAt),
        } },
      },
      {
        update: { name: invitation.name!, fields: {
          status: stringValue('accepted'),
          acceptedBy: stringValue(account.localId),
          acceptedAt: timestampValue(acceptedAt),
          updatedAt: timestampValue(acceptedAt),
        } },
        updateMask: { fieldPaths: ['status', 'acceptedBy', 'acceptedAt', 'updatedAt'] },
        ...(invitation.updateTime ? { currentDocument: { updateTime: invitation.updateTime } } : {}),
      },
    ];
    await commitWrites(projectId, accessToken, writes, true);
  }
}

async function ensurePersonalMembershipMirror(projectId: string, accessToken: string, account: FirebaseAccount) {
  if (normalizeEmail(account.email) !== BOOTSTRAP_OWNER_EMAIL) return;
  const workspaceId = `personal_${account.localId}`;
  const membershipPath = `workspaces/${workspaceId}/members/${account.localId}`;
  const membership = await getDocument(projectId, accessToken, membershipPath);
  if (!membership) return;
  const role = memberRole(membership) || 'owner';
  const now = new Date().toISOString();
  const mirrorId = await stableId('user-workspace', account.localId, workspaceId);
  await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, membershipPath), fields: memberFields(account, role, now) },
      updateMask: { fieldPaths: ['userId', 'role', 'displayName', 'email', 'emailLower', 'photoURL', 'updatedAt'] },
      currentDocument: { exists: true },
    },
    {
      update: { name: documentName(projectId, `userWorkspaceMemberships/${mirrorId}`), fields: {
        userId: stringValue(account.localId), workspaceId: stringValue(workspaceId), role: stringValue(role), updatedAt: timestampValue(now),
      } },
    },
  ]);
}

async function listWorkspaces(projectId: string, accessToken: string, account: FirebaseAccount) {
  await acceptPendingInvitations(projectId, accessToken, account);
  await ensurePersonalMembershipMirror(projectId, accessToken, account);
  const mirrors = await queryRootCollection(projectId, accessToken, 'userWorkspaceMemberships', 'userId', account.localId, 50);
  const workspaces = await Promise.all(mirrors.map(async (mirror) => {
    const workspaceId = fieldString(mirror, 'workspaceId');
    if (!validWorkspaceId(workspaceId)) return null;
    if (workspaceId.startsWith('personal_') && normalizeEmail(account.email) !== BOOTSTRAP_OWNER_EMAIL) return null;
    const [workspace, membership] = await Promise.all([
      getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
      getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${account.localId}`),
    ]);
    const role = memberRole(membership);
    if (!workspace || !membership || !role) return null;
    const now = new Date().toISOString();
    await commitWrites(projectId, accessToken, [{
      update: { name: documentName(projectId, `workspaces/${workspaceId}/members/${account.localId}`), fields: memberFields(account, role, now) },
      updateMask: { fieldPaths: ['userId', 'role', 'displayName', 'email', 'emailLower', 'photoURL', 'updatedAt'] },
      currentDocument: { exists: true },
    }]);
    return {
      id: workspaceId,
      name: fieldString(workspace, 'name') || 'ORIN AI workspace',
      role,
      plan: fieldString(workspace, 'plan') || 'starter',
    };
  }));
  return workspaces.filter((workspace): workspace is NonNullable<typeof workspace> => Boolean(workspace));
}

async function listTeam(projectId: string, accessToken: string, workspaceId: string, uid: string) {
  const access = await requireMembership(projectId, accessToken, workspaceId, uid);
  const documents = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/members`, 100);
  const members = documents.flatMap((member) => {
    const userId = fieldString(member, 'userId') || member.name?.split('/').pop() || '';
    const role = memberRole(member);
    if (!validUserId(userId) || !role) return [];
    return [{
      userId,
      role,
      displayName: fieldString(member, 'displayName') || (userId === access.ownerId ? 'Workspace owner' : 'Team member'),
      email: fieldString(member, 'email'),
      photoURL: fieldString(member, 'photoURL'),
      joinedAt: fieldString(member, 'joinedAt'),
      isOwner: userId === access.ownerId,
    }];
  });
  const canAdmin = access.role === 'owner' || access.role === 'admin';
  const invitations = canAdmin
    ? (await queryRootCollection(projectId, accessToken, 'workspaceInvitations', 'workspaceId', workspaceId, 50)).flatMap((invitation) => {
      if (fieldString(invitation, 'status') !== 'pending' || new Date(fieldString(invitation, 'expiresAt')).getTime() <= Date.now()) return [];
      const invitationId = invitation.name?.split('/').pop() || '';
      return [{
        id: invitationId,
        email: fieldString(invitation, 'email'),
        role: fieldString(invitation, 'role'),
        invitedAt: fieldString(invitation, 'invitedAt'),
        expiresAt: fieldString(invitation, 'expiresAt'),
      }];
    })
    : [];
  return { members, invitations, role: access.role, ownerId: access.ownerId };
}

async function inviteMember(projectId: string, accessToken: string, account: FirebaseAccount, body: TeamAccessBody) {
  const workspaceId = clean(body.workspaceId, 200);
  const email = normalizeEmail(body.email);
  const role = clean(body.role, 20) as TeamRole;
  const requestId = clean(body.requestId, 128);
  if (!email || !inviteRoles.has(role)) throw new Error('INVALID_REQUEST');
  const access = await requireMembership(projectId, accessToken, workspaceId, account.localId);
  if (!['owner', 'admin'].includes(access.role)) throw new Error('FORBIDDEN');
  if (role === 'admin' && access.role !== 'owner') throw new Error('TEAM_OWNER_REQUIRED');
  if (email === normalizeEmail(account.email)) throw new Error('TEAM_ALREADY_MEMBER');
  await reserveTeamRate(projectId, accessToken, workspaceId, account.localId);
  const invitationId = await stableId('workspace-invitation', workspaceId, email);
  const reservation = await mutationReservation(projectId, workspaceId, account.localId, 'invite_member', requestId);
  if (await getDocument(projectId, accessToken, reservation.path)) return { ok: true, invitationId, duplicate: true };
  const [members, invitations] = await Promise.all([
    listDocuments(projectId, accessToken, `workspaces/${workspaceId}/members`, 100),
    queryRootCollection(projectId, accessToken, 'workspaceInvitations', 'workspaceId', workspaceId, 100),
  ]);
  if (members.some((member) => fieldString(member, 'emailLower') === email)) throw new Error('TEAM_ALREADY_MEMBER');
  const pending = invitations.filter((invitation) => fieldString(invitation, 'status') === 'pending' && new Date(fieldString(invitation, 'expiresAt')).getTime() > Date.now());
  if (members.length + pending.length >= 25) throw new Error('TEAM_LIMIT_REACHED');
  const now = new Date();
  const outcome = await commitTeamMutation(projectId, accessToken, reservation, [{
    update: { name: documentName(projectId, `workspaceInvitations/${invitationId}`), fields: {
      workspaceId: stringValue(workspaceId),
      email: stringValue(email),
      emailLower: stringValue(email),
      role: stringValue(role),
      status: stringValue('pending'),
      invitedBy: stringValue(account.localId),
      invitedByName: stringValue(displayName(account)),
      invitedAt: timestampValue(now.toISOString()),
      expiresAt: timestampValue(new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000).toISOString()),
      updatedAt: timestampValue(now.toISOString()),
    } },
  }]);
  return { ok: true, invitationId, duplicate: outcome.duplicate };
}

async function updateMember(projectId: string, accessToken: string, account: FirebaseAccount, body: TeamAccessBody) {
  const workspaceId = clean(body.workspaceId, 200);
  const targetUserId = clean(body.targetUserId, 200);
  const role = clean(body.role, 20) as TeamRole;
  const requestId = clean(body.requestId, 128);
  if (!validUserId(targetUserId) || !editableRoles.has(role)) throw new Error('INVALID_REQUEST');
  const access = await requireMembership(projectId, accessToken, workspaceId, account.localId);
  if (!['owner', 'admin'].includes(access.role)) throw new Error('FORBIDDEN');
  if (targetUserId === access.ownerId || targetUserId === account.localId) throw new Error('TEAM_OWNER_REQUIRED');
  await reserveTeamRate(projectId, accessToken, workspaceId, account.localId);
  const reservation = await mutationReservation(projectId, workspaceId, account.localId, 'update_member', requestId);
  if (await getDocument(projectId, accessToken, reservation.path)) return { ok: true, role, duplicate: true };
  const target = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${targetUserId}`);
  const targetRole = memberRole(target);
  if (!target || !targetRole) throw new Error('TEAM_MEMBER_NOT_FOUND');
  if ((role === 'admin' || targetRole === 'admin') && access.role !== 'owner') throw new Error('TEAM_OWNER_REQUIRED');
  const mirrorId = await stableId('user-workspace', targetUserId, workspaceId);
  const now = new Date().toISOString();
  const outcome = await commitTeamMutation(projectId, accessToken, reservation, [
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/members/${targetUserId}`), fields: { role: stringValue(role), updatedAt: timestampValue(now) } },
      updateMask: { fieldPaths: ['role', 'updatedAt'] },
      ...(target.updateTime ? { currentDocument: { updateTime: target.updateTime } } : { currentDocument: { exists: true } }),
    },
    {
      update: { name: documentName(projectId, `userWorkspaceMemberships/${mirrorId}`), fields: { userId: stringValue(targetUserId), workspaceId: stringValue(workspaceId), role: stringValue(role), updatedAt: timestampValue(now) } },
    },
  ]);
  return { ok: true, role, duplicate: outcome.duplicate };
}

async function removeMember(projectId: string, accessToken: string, account: FirebaseAccount, body: TeamAccessBody) {
  const workspaceId = clean(body.workspaceId, 200);
  const targetUserId = clean(body.targetUserId, 200);
  const requestId = clean(body.requestId, 128);
  if (!validUserId(targetUserId)) throw new Error('INVALID_REQUEST');
  const access = await requireMembership(projectId, accessToken, workspaceId, account.localId);
  if (!['owner', 'admin'].includes(access.role)) throw new Error('FORBIDDEN');
  if (targetUserId === access.ownerId || targetUserId === account.localId) throw new Error('TEAM_OWNER_REQUIRED');
  await reserveTeamRate(projectId, accessToken, workspaceId, account.localId);
  const reservation = await mutationReservation(projectId, workspaceId, account.localId, 'remove_member', requestId);
  if (await getDocument(projectId, accessToken, reservation.path)) return { ok: true, duplicate: true };
  const target = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${targetUserId}`);
  const targetRole = memberRole(target);
  if (!target || !targetRole) throw new Error('TEAM_MEMBER_NOT_FOUND');
  if (targetRole === 'admin' && access.role !== 'owner') throw new Error('TEAM_OWNER_REQUIRED');
  const mirrorId = await stableId('user-workspace', targetUserId, workspaceId);
  const outcome = await commitTeamMutation(projectId, accessToken, reservation, [
    { delete: documentName(projectId, `workspaces/${workspaceId}/members/${targetUserId}`), currentDocument: { exists: true } },
    { delete: documentName(projectId, `userWorkspaceMemberships/${mirrorId}`) },
  ]);
  return { ok: true, duplicate: outcome.duplicate };
}

async function cancelInvitation(projectId: string, accessToken: string, account: FirebaseAccount, body: TeamAccessBody) {
  const workspaceId = clean(body.workspaceId, 200);
  const invitationId = clean(body.invitationId, 80);
  const requestId = clean(body.requestId, 128);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(invitationId)) throw new Error('INVALID_REQUEST');
  const access = await requireMembership(projectId, accessToken, workspaceId, account.localId);
  if (!['owner', 'admin'].includes(access.role)) throw new Error('FORBIDDEN');
  await reserveTeamRate(projectId, accessToken, workspaceId, account.localId);
  const reservation = await mutationReservation(projectId, workspaceId, account.localId, 'cancel_invitation', requestId);
  if (await getDocument(projectId, accessToken, reservation.path)) return { ok: true, duplicate: true };
  const invitation = await getDocument(projectId, accessToken, `workspaceInvitations/${invitationId}`);
  if (!invitation || fieldString(invitation, 'workspaceId') !== workspaceId || fieldString(invitation, 'status') !== 'pending') throw new Error('TEAM_INVITATION_NOT_FOUND');
  const now = new Date().toISOString();
  const outcome = await commitTeamMutation(projectId, accessToken, reservation, [{
    update: { name: invitation.name!, fields: { status: stringValue('cancelled'), cancelledBy: stringValue(account.localId), cancelledAt: timestampValue(now), updatedAt: timestampValue(now) } },
    updateMask: { fieldPaths: ['status', 'cancelledBy', 'cancelledAt', 'updatedAt'] },
    ...(invitation.updateTime ? { currentDocument: { updateTime: invitation.updateTime } } : { currentDocument: { exists: true } }),
  }]);
  return { ok: true, duplicate: outcome.duplicate };
}

async function markNotificationRead(projectId: string, accessToken: string, account: FirebaseAccount, body: TeamAccessBody) {
  const workspaceId = clean(body.workspaceId, 200);
  const notificationId = clean(body.notificationId, 80);
  const requestId = clean(body.requestId, 128);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(notificationId)) throw new Error('INVALID_REQUEST');
  await requireMembership(projectId, accessToken, workspaceId, account.localId);
  const reservation = await mutationReservation(projectId, workspaceId, account.localId, 'mark_notification_read', requestId);
  if (await getDocument(projectId, accessToken, reservation.path)) return { ok: true, duplicate: true };
  const notification = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/notifications/${notificationId}`);
  if (!notification || fieldString(notification, 'recipientId') !== account.localId) throw new Error('TEAM_NOTIFICATION_NOT_FOUND');
  const now = new Date().toISOString();
  const outcome = await commitTeamMutation(projectId, accessToken, reservation, [{
    update: { name: notification.name!, fields: { status: stringValue('read'), readAt: timestampValue(now), updatedAt: timestampValue(now) } },
    updateMask: { fieldPaths: ['status', 'readAt', 'updatedAt'] },
    currentDocument: { exists: true },
  }]);
  return { ok: true, duplicate: outcome.duplicate };
}

export async function handleTeamAccess(req: ServerRequest, body: TeamAccessBody) {
  const account = await verifyFirebaseAccount(req);
  const action = clean(body.action, 40);
  const { projectId, accessToken } = await googleAccessToken();
  if (action === 'list_workspaces') return { ok: true, workspaces: await listWorkspaces(projectId, accessToken, account) };
  if (action === 'list_members') {
    const workspaceId = clean(body.workspaceId, 200);
    return { ok: true, ...(await listTeam(projectId, accessToken, workspaceId, account.localId)) };
  }
  if (action === 'invite_member') return inviteMember(projectId, accessToken, account, body);
  if (action === 'update_member') return updateMember(projectId, accessToken, account, body);
  if (action === 'remove_member') return removeMember(projectId, accessToken, account, body);
  if (action === 'cancel_invitation') return cancelInvitation(projectId, accessToken, account, body);
  if (action === 'mark_notification_read') return markNotificationRead(projectId, accessToken, account, body);
  if (action === 'connect_webhook' || action === 'disconnect_webhook') {
    const workspaceId = clean(body.workspaceId, 200);
    if (!validWorkspaceId(workspaceId)) throw new Error('INVALID_REQUEST');
    await reserveTeamRate(projectId, accessToken, workspaceId, account.localId);
    return action === 'connect_webhook'
      ? connectVerifiedWebhook(projectId, accessToken, account, body)
      : disconnectVerifiedWebhook(projectId, accessToken, account, body);
  }
  throw new Error('INVALID_REQUEST');
}
