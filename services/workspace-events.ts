import { collection, onSnapshot, type Timestamp } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from './firebase';

export type WorkspaceEvent = {
  id: string;
  type: string;
  channel: string;
  conversationId: string;
  contactId: string;
  value: number;
  firstResponseMs: number | null;
  occurredAt?: Timestamp;
};

const numberOrZero = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function useWorkspaceEvents(workspaceId?: string) {
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !workspaceId) {
      setEvents([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    return onSnapshot(collection(db, 'workspaces', workspaceId, 'events'), (snapshot) => {
      setEvents(snapshot.docs.map((event) => ({
        id: event.id,
        type: typeof event.data().type === 'string' ? event.data().type : 'unknown',
        channel: typeof event.data().channel === 'string' ? event.data().channel : 'Unspecified',
        conversationId: typeof event.data().conversationId === 'string' ? event.data().conversationId : '',
        contactId: typeof event.data().contactId === 'string' ? event.data().contactId : '',
        value: numberOrZero(event.data().value),
        firstResponseMs: typeof event.data().firstResponseMs === 'number' ? event.data().firstResponseMs : null,
        occurredAt: event.data().occurredAt as Timestamp | undefined,
      })).sort((a, b) => (b.occurredAt?.toMillis() || 0) - (a.occurredAt?.toMillis() || 0)));
      setError('');
      setLoading(false);
    }, (cause) => {
      setError(cause.message);
      setLoading(false);
    });
  }, [workspaceId]);

  const metrics = useMemo(() => {
    const conversations = events.filter((event) => event.type === 'conversation.started').length;
    const resolved = events.filter((event) => event.type === 'conversation.resolved').length;
    const escalated = events.filter((event) => event.type === 'conversation.escalated').length;
    const leads = events.filter((event) => event.type === 'lead.captured').length;
    const attributedValue = events
      .filter((event) => event.type === 'value.attributed')
      .reduce((total, event) => total + event.value, 0);
    const firstResponses = events
      .map((event) => event.firstResponseMs)
      .filter((value): value is number => value !== null && value >= 0)
      .sort((a, b) => a - b);
    const middle = Math.floor(firstResponses.length / 2);
    const medianFirstResponseMs = firstResponses.length
      ? firstResponses.length % 2
        ? firstResponses[middle]
        : (firstResponses[middle - 1] + firstResponses[middle]) / 2
      : null;

    return {
      conversations,
      resolved,
      escalated,
      leads,
      attributedValue,
      resolutionRate: conversations ? Math.round((resolved / conversations) * 100) : 0,
      escalationRate: conversations ? Math.round((escalated / conversations) * 100) : 0,
      medianFirstResponseMs,
    };
  }, [events]);

  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    events.filter((event) => event.type === 'conversation.started').forEach((event) => {
      counts.set(event.channel, (counts.get(event.channel) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [events]);

  return { channels, error, events, loading, metrics };
}

export function formatResponseTime(value: number | null) {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} sec`;
  return `${(value / 60_000).toFixed(1)} min`;
}
