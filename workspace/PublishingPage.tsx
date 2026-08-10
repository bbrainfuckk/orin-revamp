import { BarChart3, CalendarDays, Check, Clock3, ExternalLink, ImagePlus, RefreshCw, Repeat2, Send, ShieldCheck, Trash2, X } from 'lucide-react';
import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ServiceIcon } from '../components/ServiceIcon';
import { useAuth } from '../contexts/AuthContext';
import { db, storage } from '../services/firebase';

const channels = [
  ['facebook', 'Facebook', 'oauth'], ['instagram', 'Instagram', 'oauth'], ['tiktok', 'TikTok', 'oauth'], ['youtube', 'YouTube', 'oauth'],
  ['linkedin', 'LinkedIn', 'oauth'], ['threads', 'Threads', 'oauth'], ['pinterest', 'Pinterest', 'oauth'], ['x', 'X', 'oauth'],
  ['google_business', 'Google Business', 'oauth'], ['reddit', 'Reddit', 'approval'], ['bluesky', 'Bluesky', 'token'],
  ['mastodon', 'Mastodon', 'token'], ['telegram', 'Telegram', 'token'],
] as const;
type ChannelId = typeof channels[number][0];
type SocialPost = { id: string; text: string; mediaUrl: string; status: string; targets: Array<{ provider: ChannelId }>; scheduledAt?: Timestamp; recurrence: string; runNumber: number; maxRuns: number };
type Delivery = { id: string; postId: string; provider: ChannelId; status: string; error: string; bytesSent: number; requestCount: number };
type PublishResult = { ok?: boolean; error?: string; postId?: string; status?: string; recurrence?: string; maxRuns?: number; deliveries?: Array<{ provider: ChannelId; status: string }>; scheduler?: { ready?: boolean; reason?: string } };
type MetaPageOption = { id: string; name: string; avatar: string };
type MetricKey = 'impressions' | 'reach' | 'engagements' | 'clicks' | 'reactions' | 'comments' | 'shares' | 'saves' | 'videoViews';
type MetricValues = Partial<Record<MetricKey, number | null>>;
type AnalyticsState = 'live' | 'partial' | 'delivery_only' | 'unsupported' | 'error' | 'not_synced';
type SocialAnalytics = {
  ok?: boolean;
  error?: string;
  generatedAt: string;
  lastSyncedAt: string;
  windowed?: boolean;
  windowLimit?: number;
  window?: { type: string; limit: number; label: string };
  coverage: { delivered: number; total?: number; eligible?: number; tracked: number; percent: number };
  totals: Record<MetricKey, number | null>;
  metricCoverage?: Partial<Record<MetricKey, number>>;
  engagementRate: number | null;
  engagementRateCoverage?: number;
  channels: Array<{ provider: ChannelId; deliveries: number; tracked: number; metrics: MetricValues; metricCoverage?: Partial<Record<MetricKey, number>>; lastSyncedAt: string; states: AnalyticsState[] }>;
  posts: Array<{ id: string; postId: string; provider: ChannelId; accountId: string; externalId: string; externalUrl: string; state: AnalyticsState; source: string; error: string; publishedAt: string; syncedAt: string; metrics: MetricValues; text: string; mediaUrl: string }>;
  refresh?: { attempted: number; refreshed: number; failed: number; busy?: boolean; retryAfterSeconds?: number };
};
type ApiResult = PublishResult & Partial<SocialAnalytics>;

const requestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `social_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const localInputMinimum = () => { const date = new Date(Date.now() + 120_000); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const directMediaUploadReady = import.meta.env.VITE_FIREBASE_STORAGE_READY === 'true';
function niceError(value: string) {
  const code = value.split(':')[0];
  return ({ PROVIDER_NOT_CONNECTED: 'Connect this channel before publishing.', PROVIDER_ACCOUNT_NOT_FOUND: 'Choose a connected account for this channel.', PROVIDER_DELIVERY_FAILED: 'The provider rejected this post. Reconnect the channel once to refresh publishing permission, then try again.', MEDIA_UPLOAD_NOT_READY: 'This channel needs its native media upload flow. Publish text for now.', PROVIDER_REJECTED_CREDENTIALS: 'The provider rejected these credentials.', INVALID_CONNECTION: 'Check the account details and try again.', INVALID_SCHEDULE: 'Choose a future publishing time.', AUTOPOST_REQUIRES_SCHEDULE: 'Choose the first publishing time for the autoposter.', INVALID_RUN_COUNT: 'Choose between 2 and 365 autoposter runs.', SCHEDULER_NOT_CONFIGURED: 'Scheduled publishing is unavailable until the production scheduler is online.', POST_NOT_FOUND: 'This campaign no longer exists.', POST_NOT_CANCELLABLE: 'Only campaigns waiting to publish can be cancelled.', POST_NOT_RETRYABLE: 'Only failed deliveries can be retried.', POST_CHANGED: 'This campaign changed in another session. Refresh and try again.' } as Record<string, string>)[code] || value.replaceAll('_', ' ').toLowerCase();
}
const channelName = (provider: string) => channels.find(([id]) => id === provider)?.[1] || provider.replaceAll('_', ' ');
const metricValue = (value: number | null | undefined) => typeof value === 'number' ? value.toLocaleString('en-PH') : '\u2014';
const formatAnalyticsTime = (value: string, fallback = 'Not synced yet') => {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const analyticsState = (state: AnalyticsState, error = '') => ({
  live: { label: 'Reporting', detail: 'Metrics read from the provider.' },
  partial: { label: 'Partial metrics', detail: 'The provider returned only the metrics available for this post.' },
  delivery_only: { label: 'Delivery only', detail: 'Delivery is confirmed, but this connection exposes no post metrics.' },
  unsupported: { label: 'Not exposed', detail: 'This provider API does not expose post analytics for this connection.' },
  error: { label: 'Sync failed', detail: error || 'The provider metrics request failed. The delivery record is preserved.' },
  not_synced: { label: 'Not synced', detail: 'Refresh analytics to request the latest provider metrics.' },
}[state] || { label: 'Unavailable', detail: 'No provider analytics state was returned.' });

export function PublishingPage() {
  const { user, workspace } = useAuth();
  const [posts, setPosts] = useState<SocialPost[]>([]); const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [connections, setConnections] = useState<Set<string>>(new Set()); const [metaPages, setMetaPages] = useState<MetaPageOption[]>([]); const [instagramAccounts, setInstagramAccounts] = useState<MetaPageOption[]>([]); const [text, setText] = useState('');
  const [mediaUrl, setMediaUrl] = useState(''); const [scheduledAt, setScheduledAt] = useState(''); const [targets, setTargets] = useState<ChannelId[]>([]);
  const [variants, setVariants] = useState<Partial<Record<ChannelId, string>>>({}); const [accountIds, setAccountIds] = useState<Partial<Record<ChannelId, string>>>({}); const [connectProvider, setConnectProvider] = useState<ChannelId | ''>('');
  const [credential, setCredential] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [autoPost, setAutoPost] = useState(false); const [recurrence, setRecurrence] = useState('daily'); const [maxRuns, setMaxRuns] = useState(30);
  const [schedulerReady, setSchedulerReady] = useState(false); const [schedulerChecked, setSchedulerChecked] = useState(false); const [postActionId, setPostActionId] = useState('');
  const [mediaUploading, setMediaUploading] = useState(false); const [mediaFileName, setMediaFileName] = useState('');
  const [queueFilter, setQueueFilter] = useState<'pending' | 'published' | 'attention'>('pending');
  const [publishMode, setPublishMode] = useState<'now' | 'schedule'>('now');
  const [analytics, setAnalytics] = useState<SocialAnalytics | null>(null); const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsRefreshing, setAnalyticsRefreshing] = useState(false); const [analyticsError, setAnalyticsError] = useState(''); const [analyticsNotice, setAnalyticsNotice] = useState('');
  const [analyticsVisiblePosts, setAnalyticsVisiblePosts] = useState(20);
  const analyticsAutoRefresh = useRef('');
  const analyticsWorkspace = useRef('');
  const canEdit = workspace?.role !== 'viewer';

  useEffect(() => {
    if (!db || !workspace) return undefined;
    const stopPosts = onSnapshot(query(collection(db, 'workspaces', workspace.id, 'socialPosts'), orderBy('createdAt', 'desc'), limit(30)), (snapshot) => setPosts(snapshot.docs.map((item) => {
      const data = item.data(); let parsed: Array<{ provider: ChannelId }> = [];
      try { parsed = JSON.parse(typeof data.targetsJson === 'string' ? data.targetsJson : '[]'); } catch { parsed = []; }
      return { id: item.id, text: String(data.text || ''), mediaUrl: String(data.mediaUrl || ''), status: String(data.status || 'draft'), targets: parsed, scheduledAt: data.scheduledAt as Timestamp | undefined, recurrence: String(data.recurrence || 'none'), runNumber: Number(data.runNumber || 1), maxRuns: Number(data.maxRuns || 1) };
    })), () => setPosts([]));
    const stopDeliveries = onSnapshot(query(collection(db, 'workspaces', workspace.id, 'socialDeliveries'), limit(100)), (snapshot) => setDeliveries(snapshot.docs.map((item) => ({ id: item.id, postId: String(item.data().postId || ''), provider: item.data().provider as ChannelId, status: String(item.data().status || ''), error: String(item.data().error || ''), bytesSent: Number(item.data().bytesSent || 0), requestCount: Number(item.data().requestCount || 0) }))));
    const stopConnections = onSnapshot(collection(db, 'workspaces', workspace.id, 'connections'), (snapshot) => {
      const ready = new Set(snapshot.docs.filter((item) => item.data().status === 'connected' && ['healthy','configuration_valid','awaiting_first_event'].includes(item.data().health)).map((item) => item.id.replace(/^social_/, '')));
      const meta = snapshot.docs.find((item) => item.id === 'meta' && item.data().authorizationStatus === 'authorized');
      const metaData = meta?.data() || {};
      const pageIds = Array.isArray(metaData.pageIds) ? metaData.pageIds.filter((id): id is string => typeof id === 'string') : [];
      const pageNames = Array.isArray(metaData.pageNames) ? metaData.pageNames : [];
      const pageAvatars = Array.isArray(metaData.pageAvatars) ? metaData.pageAvatars : [];
      const instagramIds = Array.isArray(metaData.instagramAccountIds) ? metaData.instagramAccountIds.filter((id): id is string => typeof id === 'string') : [];
      const instagramLabels = Array.isArray(metaData.instagramAccountLabels) ? metaData.instagramAccountLabels : [];
      const instagramAvatars = Array.isArray(metaData.instagramAvatars) ? metaData.instagramAvatars : [];
      setMetaPages(pageIds.map((id, index) => ({ id, name: typeof pageNames[index] === 'string' ? pageNames[index] : `Facebook Page ${index + 1}`, avatar: typeof pageAvatars[index] === 'string' ? pageAvatars[index] : '' })));
      setInstagramAccounts(instagramIds.map((id, index) => ({ id, name: typeof instagramLabels[index] === 'string' ? instagramLabels[index] : `Instagram account ${index + 1}`, avatar: typeof instagramAvatars[index] === 'string' ? instagramAvatars[index] : '' })));
      if (meta && pageIds.length) ready.add('facebook');
      if (metaData.instagramPublishingReady === true && instagramIds.length) ready.add('instagram');
      setConnections(ready);
    });
    return () => { stopPosts(); stopDeliveries(); stopConnections(); };
  }, [workspace]);

  const usage = useMemo(() => deliveries.reduce((sum, item) => ({ requests: sum.requests + item.requestCount, bytes: sum.bytes + item.bytesSent, delivered: sum.delivered + Number(item.status === 'delivered') }), { requests: 0, bytes: 0, delivered: 0 }), [deliveries]);
  const callApi = useCallback(async (action: string, payload: Record<string, unknown>) => {
    if (!user || !workspace) throw new Error('Workspace is not ready.');
    const response = await fetch(`/api/social/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: workspace.id, ...payload }) });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (!response.ok || !result.ok) throw new Error(result.error || 'Request failed.');
    return result;
  }, [user, workspace]);
  const loadAnalytics = useCallback(async (refresh = false) => {
    refresh ? setAnalyticsRefreshing(true) : setAnalyticsLoading(true);
    setAnalyticsError('');
    if (refresh) setAnalyticsNotice('');
    try {
      const result = await callApi(refresh ? 'refresh_analytics' : 'analytics', {});
      if (!result.coverage || !result.totals || !Array.isArray(result.channels) || !Array.isArray(result.posts)) throw new Error('Analytics data was incomplete. Try refreshing it.');
      analyticsWorkspace.current = workspace?.id || '';
      setAnalytics(result as SocialAnalytics);
      setAnalyticsVisiblePosts(20);
      if (refresh) {
        const report = result.refresh;
        setAnalyticsNotice(report?.busy ? 'Another refresh is already running. Showing the latest saved metrics.' : report?.attempted === 0 ? 'Provider metrics are already current.' : report ? `${report.refreshed} of ${report.attempted} provider record${report.attempted === 1 ? '' : 's'} refreshed${report.failed ? `; ${report.failed} need${report.failed === 1 ? 's' : ''} attention` : ''}.` : 'Provider metrics refreshed.');
      }
    } catch (cause) {
      setAnalyticsError(niceError(cause instanceof Error ? cause.message : 'Analytics could not be loaded.'));
    } finally {
      refresh ? setAnalyticsRefreshing(false) : setAnalyticsLoading(false);
    }
  }, [callApi, workspace?.id]);
  const submit = async () => { setBusy(true); setError(''); setNotice(''); try { const shouldSchedule = autoPost || publishMode === 'schedule'; const result = await callApi('publish', { requestId: requestId(), text, mediaUrl, scheduledAt: shouldSchedule && scheduledAt ? new Date(scheduledAt).toISOString() : '', recurrence: autoPost ? recurrence : 'none', maxRuns: autoPost ? maxRuns : 1, targets: targets.map((provider) => ({ provider, accountId: accountIds[provider] || (provider === 'facebook' ? metaPages[0]?.id || '' : provider === 'instagram' ? instagramAccounts[0]?.id || '' : ''), variant: variants[provider] || '' })) }); const delivered = result.deliveries?.filter((item) => item.status === 'delivered').length || 0; setNotice(autoPost ? `Autoposter scheduled for ${maxRuns} runs across ${targets.length} channel${targets.length === 1 ? '' : 's'}.` : result.status === 'scheduled' ? `Post scheduled across ${targets.length} channel${targets.length === 1 ? '' : 's'}.` : `${delivered} of ${targets.length} channel${targets.length === 1 ? '' : 's'} confirmed delivery.`); setText(''); setMediaUrl(''); setMediaFileName(''); setScheduledAt(''); setVariants({}); setAutoPost(false); setPublishMode('now'); setQueueFilter(result.status === 'scheduled' ? 'pending' : 'published'); } catch (cause) { setError(niceError(cause instanceof Error ? cause.message : 'Publishing failed.')); } finally { setBusy(false); } };
  const connect = async () => { if (!connectProvider) return; setBusy(true); setError(''); setNotice(''); try { await callApi('connect', { provider: connectProvider, credential }); setNotice(`${channels.find(([id]) => id === connectProvider)?.[1]} is connected and ready.`); setConnectProvider(''); setCredential({}); } catch (cause) { setError(niceError(cause instanceof Error ? cause.message : 'Connection failed.')); } finally { setBusy(false); } };
  const disconnect = async (provider: ChannelId) => { setBusy(true); setError(''); setNotice(''); try { await callApi('disconnect', { provider }); setTargets((current) => current.filter((item) => item !== provider)); setNotice(`${channels.find(([id]) => id === provider)?.[1]} was disconnected.`); } catch (cause) { setError(niceError(cause instanceof Error ? cause.message : 'Disconnect failed.')); } finally { setBusy(false); } };
  const actOnPost = async (postId: string, action: 'cancel' | 'retry') => { setPostActionId(postId); setError(''); setNotice(''); try { const result = await callApi(action, { postId }); setNotice(action === 'cancel' ? 'Scheduled campaign cancelled.' : result.status === 'delivered' ? 'Every channel confirmed delivery.' : 'Retry completed. Review the delivery ledger for any channel that still needs attention.'); } catch (cause) { setError(niceError(cause instanceof Error ? cause.message : 'Post action failed.')); } finally { setPostActionId(''); } };
  useEffect(() => { let active = true; if (!user || !workspace) return undefined; void callApi('scheduler_status', {}).then((result) => { if (active) { setSchedulerReady(result.scheduler?.ready === true); setSchedulerChecked(true); } }).catch(() => { if (active) { setSchedulerReady(false); setSchedulerChecked(true); } }); return () => { active = false; }; }, [callApi, user, workspace]);
  useEffect(() => { if (user && workspace) void loadAnalytics(); }, [loadAnalytics, user, workspace]);
  useEffect(() => {
    if (!analytics || !workspace || analyticsWorkspace.current !== workspace.id || !canEdit || analyticsLoading || analyticsRefreshing) return;
    const lastSync = Date.parse(analytics.lastSyncedAt) || 0;
    if (lastSync && Date.now() - lastSync <= 15 * 60_000) return;
    const refreshKey = `${workspace.id}:${analytics.lastSyncedAt || 'missing'}`;
    if (analyticsAutoRefresh.current === refreshKey) return;
    analyticsAutoRefresh.current = refreshKey;
    void loadAnalytics(true);
  }, [analytics, analyticsLoading, analyticsRefreshing, canEdit, loadAnalytics, workspace]);
  const connectedTargets = channels.filter(([id]) => connections.has(id)).map(([id]) => id);
  const activeAutoposters = posts.filter((post) => post.status === 'scheduled' && post.recurrence !== 'none').length;
  const postGroups = useMemo(() => ({
    pending: posts.filter((post) => post.status === 'scheduled'),
    published: posts.filter((post) => ['delivered', 'partially_delivered'].includes(post.status)),
    attention: posts.filter((post) => !['scheduled', 'delivered', 'partially_delivered'].includes(post.status)),
  }), [posts]);
  const uploadMedia = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!directMediaUploadReady || !user || !workspace || !storage) { setError('Secure photo upload is not enabled yet. Use a public image URL below.'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Attach a JPG, PNG, or WebP image.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Photos must be 10 MB or smaller.'); return; }
    setMediaUploading(true);
    try {
      const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const object = storageRef(storage, `workspaces/${workspace.id}/publishing/${user.uid}/${requestId()}.${extension}`);
      const snapshot = await uploadBytes(object, file, { contentType: file.type, customMetadata: { workspaceId: workspace.id, uploadedBy: user.uid } });
      setMediaUrl(await getDownloadURL(snapshot.ref));
      setMediaFileName(file.name);
      setNotice('Photo attached. It will publish with this campaign.');
    } catch {
      setError('The photo could not be uploaded. Check Storage access and try again.');
    } finally {
      setMediaUploading(false);
    }
  };
  const toggleTarget = (id: ChannelId, label: string) => {
    setNotice('');
    if (!connections.has(id)) { setError(`Connect ${label} before adding it to this post.`); return; }
    setError('');
    setTargets((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return <section className="workspace-page publishing-page">
    <header className="workspace-page-heading">
      <div><span>ORIN Social</span><h1>One post. Every channel.</h1><p>Publish immediately or let ORIN run the campaign on schedule.</p></div>
      <Link className="workspace-secondary-action" to="/app/integrations">Connect channels <ExternalLink /></Link>
    </header>

    <section className="publishing-metrics">
      <article><Send /><span>Delivered</span><strong>{usage.delivered}</strong><small>Provider-confirmed posts</small></article>
      <article><ShieldCheck /><span>API requests</span><strong>{usage.requests}</strong><small>{usage.bytes < 1024 ? `${usage.bytes} B` : `${(usage.bytes / 1024).toFixed(1)} KB`} recorded</small></article>
      <article><Repeat2 /><span>Autoposters</span><strong>{activeAutoposters}</strong><small>Active recurring campaigns</small></article>
      <article><CalendarDays /><span>Scheduled</span><strong>{posts.filter((post) => post.status === 'scheduled').length}</strong><small>Waiting for dispatch</small></article>
    </section>

    <section className="publishing-analytics" aria-labelledby="publishing-analytics-heading">
      <header>
        <div><span>Provider reporting</span><h2 id="publishing-analytics-heading">Performance, from the networks themselves.</h2><p>ORIN reads the metrics exposed for each delivered post. Missing data stays missing&mdash;nothing here is estimated.</p></div>
        <div className="publishing-analytics__actions">
          {analytics && <div className="publishing-analytics__scope"><strong>{analytics.window?.label || `Latest ${analytics.windowLimit || 150} deliveries`}</strong>{analytics.lastSyncedAt && <small>Last synced {formatAnalyticsTime(analytics.lastSyncedAt)}</small>}</div>}
          <button type="button" disabled={!canEdit || analyticsLoading || analyticsRefreshing} title={!canEdit ? 'Editors can refresh provider metrics.' : 'Request the latest metrics from connected networks'} onClick={() => void loadAnalytics(true)}><RefreshCw className={analyticsRefreshing ? 'is-spinning' : ''} />{analyticsRefreshing ? 'Refreshing…' : 'Refresh analytics'}</button>
        </div>
      </header>

      {analyticsError && <div className="publishing-analytics__message is-error"><strong>Reporting needs attention.</strong><span>{analyticsError}</span>{!analytics && <button type="button" onClick={() => void loadAnalytics()}>Try again</button>}</div>}
      {analyticsNotice && <div className="publishing-analytics__message is-success"><Check /><span>{analyticsNotice}</span></div>}

      {analyticsLoading && !analytics ? <div className="publishing-analytics__loading"><RefreshCw className="is-spinning" /><div><strong>Reading provider records…</strong><span>Delivery IDs and saved metric snapshots are loading.</span></div></div> : analytics && analytics.coverage.delivered === 0 ? <div className="publishing-analytics__empty"><BarChart3 /><div><strong>Analytics begin with the first delivered post.</strong><p>Publish a campaign above. ORIN will save its provider ID and retrieve every metric that network makes available.</p></div></div> : analytics && <>
        <section className="publishing-analytics__coverage" aria-label="Analytics coverage">
          <div><strong>{analytics.coverage.tracked} of {analytics.coverage.eligible ?? analytics.coverage.delivered} eligible posts report audience metrics</strong><span>{analytics.coverage.delivered} delivered records in this window · {Math.round(analytics.coverage.percent)}% provider coverage</span></div>
          <i aria-hidden="true"><b style={{ width: `${Math.max(0, Math.min(100, analytics.coverage.percent))}%` }} /></i>
          <small>Some networks provide delivery confirmation without audience analytics. ORIN labels those separately.</small>
        </section>

        <section className="publishing-analytics__metrics" aria-label="Social publishing totals">
          {([
            ['impressions', 'Impressions', 'Times published posts were shown'],
            ['reach', 'Reach', 'Unique accounts reported by providers'],
            ['engagements', 'Engagements', 'Recorded interactions'],
            ['clicks', 'Clicks', 'Provider-reported link or post clicks'],
            ['videoViews', 'Video views', 'Views reported for video posts'],
          ] as Array<[MetricKey, string, string]>).map(([key, label, detail]) => <article key={key}><span>{label}</span><strong title={typeof analytics.totals[key] === 'number' ? analytics.totals[key].toLocaleString('en-PH') : 'Not reported by connected providers'}>{metricValue(analytics.totals[key])}</strong><small>{analytics.metricCoverage?.[key] ? `${detail} · ${analytics.metricCoverage[key]} post${analytics.metricCoverage[key] === 1 ? '' : 's'}` : `${detail} · Not reported`}</small></article>)}
          <article><span>Engagement rate</span><strong>{analytics.engagementRate === null ? '—' : `${analytics.engagementRate.toLocaleString('en-PH', { maximumFractionDigits: 2 })}%`}</strong><small>Engagements divided by impressions{analytics.engagementRateCoverage ? ` · ${analytics.engagementRateCoverage} post${analytics.engagementRateCoverage === 1 ? '' : 's'}` : ''}</small></article>
        </section>

        <section className="publishing-analytics__providers">
          <header><div><span>Channel coverage</span><h3>What each network reports</h3></div><small>{analytics.channels.length} channel{analytics.channels.length === 1 ? '' : 's'} in this window</small></header>
          {analytics.channels.length ? <div>{analytics.channels.map((channel) => <article key={channel.provider}>
            <div className="publishing-analytics__provider"><ServiceIcon service={channel.provider} label={channelName(channel.provider)} /><div><strong>{channelName(channel.provider)}</strong><small>{channel.tracked} of {channel.deliveries} post{channel.deliveries === 1 ? '' : 's'} tracked</small></div></div>
            <dl>
              <div title={channel.metricCoverage?.impressions ? `${channel.metricCoverage.impressions} contributing posts` : 'Not reported'}><dt>Impressions</dt><dd>{metricValue(channel.metrics.impressions)}</dd></div>
              <div title={channel.metricCoverage?.reach ? `${channel.metricCoverage.reach} contributing posts` : 'Not reported'}><dt>Reach</dt><dd>{metricValue(channel.metrics.reach)}</dd></div>
              <div title={channel.metricCoverage?.engagements ? `${channel.metricCoverage.engagements} contributing posts` : 'Not reported'}><dt>Engagements</dt><dd>{metricValue(channel.metrics.engagements)}</dd></div>
              <div title={channel.metricCoverage?.clicks ? `${channel.metricCoverage.clicks} contributing posts` : 'Not reported'}><dt>Clicks</dt><dd>{metricValue(channel.metrics.clicks)}</dd></div>
            </dl>
            <div className="publishing-analytics__states">{channel.states.map((state) => { const copy = analyticsState(state); return <span key={state} className={`is-${state}`} title={copy.detail}>{copy.label}</span>; })}<small>{formatAnalyticsTime(channel.lastSyncedAt)}</small></div>
          </article>)}</div> : <p className="publishing-analytics__no-data">No channel records are available in this reporting window.</p>}
        </section>

        <section className="publishing-analytics__posts">
          <header><div><span>Post-level results</span><h3>Every delivery has a source.</h3></div><small>Showing {Math.min(analyticsVisiblePosts, analytics.posts.length)} of {analytics.posts.length} recent deliveries</small></header>
          {analytics.posts.length ? <div>{analytics.posts.slice(0, analyticsVisiblePosts).map((post) => { const state = analyticsState(post.state, post.error); return <article key={post.id}>
            <div className="publishing-analytics__post-copy">{post.mediaUrl && <img src={post.mediaUrl} alt="" loading="lazy" />}<div><span><ServiceIcon service={post.provider} label={channelName(post.provider)} />{channelName(post.provider)} · {formatAnalyticsTime(post.publishedAt, 'Publish time unavailable')}</span><strong>{post.text || 'Media post'}</strong><small>{post.externalId ? `Provider ID ${post.externalId}` : 'No provider ID returned'}</small></div></div>
            <div className={`publishing-analytics__post-state is-${post.state}`}><strong>{state.label}</strong><small title={state.detail}>{state.detail}</small></div>
            <dl>
              <div><dt>Impressions</dt><dd>{metricValue(post.metrics.impressions)}</dd></div>
              <div><dt>Engagements</dt><dd>{metricValue(post.metrics.engagements)}</dd></div>
              <div><dt>Clicks</dt><dd>{metricValue(post.metrics.clicks)}</dd></div>
            </dl>
            {post.externalUrl ? <a href={post.externalUrl} target="_blank" rel="noreferrer" aria-label={`Open ${channelName(post.provider)} post`}><ExternalLink /></a> : <span className="publishing-analytics__no-link" title="This provider did not return a public post URL">—</span>}
          </article>; })}</div> : <p className="publishing-analytics__no-data">Delivered posts will appear here with their provider reporting state.</p>}
          {analyticsVisiblePosts < analytics.posts.length && <button className="publishing-analytics__more" type="button" onClick={() => setAnalyticsVisiblePosts((count) => count + 20)}>Show 20 more</button>}
        </section>
      </>}
    </section>

    {notice && <p className="publishing-notice"><Check />{notice}</p>}
    <div className="publishing-layout">
      <section className="publishing-composer">
        <header><div><span>Unified Publishing API</span><h2>Create a campaign</h2></div><small>{text.length.toLocaleString()} characters</small></header>
        <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={10000} placeholder="Write the message you want every audience to receive." disabled={!canEdit} />
        <section className="publishing-media">
          <label className="publishing-media__attach">
            <ImagePlus aria-hidden="true" />
            <span><strong>{mediaUploading ? 'Uploading photo…' : mediaFileName || 'Attach a photo'}</strong><small>{directMediaUploadReady ? 'JPG, PNG, or WebP · up to 10 MB' : 'Media storage setup required · use a URL for now'}</small></span>
            <input type="file" accept="image/jpeg,image/png,image/webp" disabled={!canEdit || mediaUploading || !directMediaUploadReady} onChange={(event) => { void uploadMedia(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
          </label>
          {mediaUrl && <div className="publishing-media__preview"><img src={mediaUrl} alt="Campaign attachment preview" /><button type="button" onClick={() => { setMediaUrl(''); setMediaFileName(''); }} aria-label="Remove attached photo"><Trash2 aria-hidden="true" /></button></div>}
          <details open={!directMediaUploadReady}><summary>{directMediaUploadReady ? 'Or use a public image URL' : 'Use a public image URL'}</summary><label><span>HTTPS image URL</span><input type="url" value={mediaUrl} onChange={(event) => { setMediaUrl(event.target.value); setMediaFileName(''); }} placeholder="https://…" /></label></details>
        </section>

        <fieldset>
          <div className="publishing-channel-heading"><strong>Choose channels</strong><button type="button" disabled={!connectedTargets.length} onClick={() => { setTargets(connectedTargets); setError(''); }}>Select all connected</button></div>
          <div className="publishing-channel-grid">{channels.map(([id, label, mode]) => {
            const connected = connections.has(id); const selected = targets.includes(id);
            return <button type="button" key={id} aria-disabled={!connected} className={`${selected ? 'is-selected' : ''} ${connected ? 'is-connected' : 'is-unavailable'}`} onClick={() => toggleTarget(id, label)}><span><ServiceIcon service={id} label={label} /></span><strong>{label}</strong><small>{connected ? 'Ready' : mode === 'token' ? 'Connect with BYOK' : mode === 'approval' ? 'Approval required' : 'OAuth approval'}</small>{selected && <Check />}</button>;
          })}</div>
        </fieldset>

        {targets.includes('facebook') && metaPages.length > 0 && <section className="publishing-account-picker">
          <ServiceIcon service="facebook" label="Facebook" />
          <label><span>Post Facebook to</span><select value={accountIds.facebook || metaPages[0].id} onChange={(event) => setAccountIds((current) => ({ ...current, facebook: event.target.value }))}>{metaPages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
          <small>{metaPages.length} connected Page{metaPages.length === 1 ? '' : 's'}</small>
        </section>}
        {targets.includes('instagram') && instagramAccounts.length > 0 && <section className="publishing-account-picker">
          <ServiceIcon service="instagram" label="Instagram" />
          <label><span>Post Instagram to</span><select value={accountIds.instagram || instagramAccounts[0].id} onChange={(event) => setAccountIds((current) => ({ ...current, instagram: event.target.value }))}>{instagramAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <small>{instagramAccounts.length} connected account{instagramAccounts.length === 1 ? '' : 's'}</small>
        </section>}

        {targets.length > 0 && <details className="publishing-variants"><summary>Tailor copy per channel</summary>{targets.map((provider) => <label key={provider}><span>{channels.find(([id]) => id === provider)?.[1]}</span><textarea value={variants[provider] || ''} onChange={(event) => setVariants((current) => ({ ...current, [provider]: event.target.value }))} placeholder="Leave blank to use the master message." /></label>)}</details>}

        <section className="publishing-mode" aria-label="Publishing time">
          <button type="button" className={publishMode === 'now' && !autoPost ? 'is-active' : ''} onClick={() => { setAutoPost(false); setPublishMode('now'); setScheduledAt(''); }}><Send />Post now<small>Publish immediately</small></button>
          <button type="button" className={publishMode === 'schedule' || autoPost ? 'is-active' : ''} disabled={!schedulerReady} onClick={() => setPublishMode('schedule')}><Clock3 />Schedule<small>{schedulerReady ? 'Choose a date and time' : 'Scheduler unavailable'}</small></button>
        </section>

        <section className={`publishing-autoposter ${autoPost ? 'is-active' : ''}`}>
          <header><Repeat2 /><div><strong>Autoposter</strong><small>{schedulerReady ? 'Repeat this campaign without rebuilding it.' : 'Scheduling unlocks when the production scheduler is online.'}</small></div><label><input type="checkbox" checked={autoPost} disabled={!schedulerReady} onChange={(event) => setAutoPost(event.target.checked)} /><span /></label></header>
          {autoPost && <div><label>Frequency<select value={recurrence} onChange={(event) => setRecurrence(event.target.value)}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></label><label>Number of posts<input type="number" min="2" max="365" value={maxRuns} onChange={(event) => setMaxRuns(Math.min(365, Math.max(2, Number(event.target.value) || 2)))} /></label></div>}
        </section>

        <footer>
          {(publishMode === 'schedule' || autoPost) && <label><Clock3 /><span>{autoPost ? 'First publish' : 'Publish at'} <small>{schedulerReady ? 'Required before scheduling' : schedulerChecked ? 'Scheduler is not online yet' : 'Checking scheduler…'}</small></span><input type="datetime-local" value={scheduledAt} min={localInputMinimum()} disabled={!schedulerReady} onChange={(event) => setScheduledAt(event.target.value)} /></label>}
          <button type="button" onClick={() => void submit()} disabled={busy || mediaUploading || !canEdit || (!text.trim() && !mediaUrl.trim()) || !targets.length || ((publishMode === 'schedule' || autoPost) && !scheduledAt)}>{busy ? 'Publishing…' : autoPost ? 'Start autoposter' : publishMode === 'schedule' ? 'Schedule post' : 'Post now'} <Send /></button>
        </footer>
        {error && <p className="workspace-inline-error">{error}</p>}
      </section>

      <aside className="publishing-channels">
        <header><span>Connections</span><h2>Your channels</h2><p>Managed OAuth first. BYOK remains available for open networks.</p></header>
        {channels.map(([id, label, mode]) => <article key={id}><span><ServiceIcon service={id} label={label} /></span><div><strong>{label}</strong><small>{connections.has(id) ? 'Healthy and ready' : mode === 'token' ? 'Direct connection available' : mode === 'approval' ? 'Partner approval required' : 'ORIN app approval required'}</small></div>{connections.has(id) ? <div className="publishing-connection-actions"><em><i /> Live</em>{mode === 'token' && <button type="button" disabled={busy} onClick={() => void disconnect(id)}>Disconnect</button>}</div> : mode === 'token' ? <button type="button" onClick={() => { setConnectProvider(id); setCredential({}); setError(''); setNotice(''); }}>Connect</button> : <Link className="publishing-manage-link" to="/app/integrations">Setup</Link>}</article>)}
      </aside>
    </div>

    <section className="publishing-ledger">
      <header><div><span>Campaign queue</span><h2>Every outcome, accounted for.</h2></div><div className="publishing-ledger-tabs" role="group" aria-label="Campaign queue filters">{(['pending', 'published', 'attention'] as const).map((filter) => <button type="button" key={filter} className={queueFilter === filter ? 'is-active' : ''} onClick={() => setQueueFilter(filter)}>{filter}<small>{postGroups[filter].length}</small></button>)}</div></header>
      {postGroups[queueFilter].length ? postGroups[queueFilter].map((post) => <article key={post.id}><time>{post.scheduledAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Now'}</time><div className="publishing-ledger__content">{post.mediaUrl && <img src={post.mediaUrl} alt="" />}<div><strong>{post.text || 'Media post'}</strong><small>{post.targets.map((target) => channels.find(([id]) => id === target.provider)?.[1] || target.provider).join(' · ')}</small>{post.recurrence !== 'none' && <small className="publishing-series">{post.recurrence} autoposter · run {post.runNumber} of {post.maxRuns}</small>}{deliveries.filter((item) => item.postId === post.id && item.error).map((item) => <em key={item.id}>{channels.find(([id]) => id === item.provider)?.[1]}: {niceError(item.error)}</em>)}</div></div><div className="publishing-ledger-actions"><span className={`publishing-status is-${post.status}`}>{post.status.replaceAll('_', ' ')}</span>{['scheduled','schedule_failed'].includes(post.status) && <button type="button" disabled={postActionId === post.id} onClick={() => void actOnPost(post.id, 'cancel')}>Cancel</button>}{['failed','partially_delivered'].includes(post.status) && <button type="button" disabled={postActionId === post.id} onClick={() => void actOnPost(post.id, 'retry')}>{postActionId === post.id ? 'Retrying…' : 'Retry'}</button>}</div></article>) : <div className="publishing-ledger__empty"><CalendarDays /><strong>{queueFilter === 'pending' ? 'No campaigns are waiting.' : queueFilter === 'published' ? 'No confirmed posts yet.' : 'Nothing needs attention.'}</strong><p>{queueFilter === 'pending' ? 'Schedule a campaign above and it will remain here until dispatch.' : queueFilter === 'published' ? 'Provider-confirmed deliveries will appear here.' : 'Failed, cancelled, and incomplete campaigns will appear here.'}</p></div>}
    </section>

    {connectProvider && <div className="publishing-dialog-backdrop"><section className="publishing-dialog" role="dialog" aria-modal="true"><header><div><span>Advanced connection</span><h2>Connect {channels.find(([id]) => id === connectProvider)?.[1]}</h2></div><button type="button" aria-label="Close" onClick={() => setConnectProvider('')}><X /></button></header><p>Your secret is tested server-side, encrypted, and never returned to this browser.</p>{connectProvider === 'telegram' && <fieldset><label>Bot token<input type="password" value={credential.botToken || ''} onChange={(event) => setCredential((current) => ({ ...current, botToken: event.target.value }))} /></label><label>Chat or channel ID<input value={credential.chatId || ''} onChange={(event) => setCredential((current) => ({ ...current, chatId: event.target.value }))} placeholder="@channel or -100…" /></label></fieldset>}{connectProvider === 'mastodon' && <fieldset><label>Instance URL<input type="url" value={credential.instanceUrl || ''} onChange={(event) => setCredential((current) => ({ ...current, instanceUrl: event.target.value }))} placeholder="https://mastodon.social" /></label><label>Access token<input type="password" value={credential.accessToken || ''} onChange={(event) => setCredential((current) => ({ ...current, accessToken: event.target.value }))} /></label></fieldset>}{connectProvider === 'bluesky' && <fieldset><label>Handle<input value={credential.handle || ''} onChange={(event) => setCredential((current) => ({ ...current, handle: event.target.value }))} placeholder="name.bsky.social" /></label><label>App password<input type="password" value={credential.appPassword || ''} onChange={(event) => setCredential((current) => ({ ...current, appPassword: event.target.value }))} /></label></fieldset>}{error && <p className="workspace-inline-error">{error}</p>}<footer><button type="button" onClick={() => setConnectProvider('')}>Cancel</button><button type="button" onClick={() => void connect()} disabled={busy}>{busy ? 'Testing…' : 'Test and connect'}</button></footer></section></div>}
  </section>;
}
