import { Boxes, Check, Copy, CreditCard, Package, Pencil, Plus, ShieldCheck, ShoppingBag, Trash2, X } from 'lucide-react';
import { collection, onSnapshot, type Timestamp } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type CatalogItem = {
  id: string; name: string; kind: 'service' | 'product' | 'material'; description: string; priceCentavos: number; quoteOnly: boolean; stock: number; variants: string[]; imageUrl: string; active: boolean;
};
type Order = {
  id: string; reference: string; itemName: string; variant: string; quantity: number; totalCentavos: number; quoteOnly: boolean; status: string; contactName: string; paymentMethod: string; createdAt?: Timestamp; paidAt?: Timestamp;
};
type PaymentConnection = { status: string; health: string; mode: string; qrphEnabled: boolean; nativeGcashEnabled: boolean; gcashAccountHint: string } | null;
type ItemDraft = { id: string; name: string; kind: CatalogItem['kind']; description: string; price: string; quoteOnly: boolean; stock: string; variants: string; imageUrl: string; active: boolean };

const emptyItem = (): ItemDraft => ({ id: '', name: '', kind: 'service', description: '', price: '', quoteOnly: true, stock: '', variants: '', imageUrl: '', active: true });
const webhookUrl = 'https://www.orin.work/api/webhooks/paymongo';
const money = (centavos: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(centavos / 100);
const statusLabel = (status: string) => ({ draft: 'Draft', quote_requested: 'Quote requested', pending_payment: 'Awaiting QRPh', pending_gcash: 'Verify GCash', payment_setup_required: 'Payment setup', paid: 'Paid', cancelled: 'Cancelled' }[status] || status.replace(/_/g, ' '));

export function CommercePage() {
  const { user, workspace } = useAuth();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [payment, setPayment] = useState<PaymentConnection>(null);
  const [draft, setDraft] = useState<ItemDraft>(emptyItem);
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [gcashNumber, setGcashNumber] = useState('');
  const [gcashAccountName, setGcashAccountName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const canAdmin = ['owner', 'admin'].includes(workspace?.role || '');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    const stopItems = onSnapshot(collection(db, 'workspaces', workspace.id, 'catalogItems'), (snapshot) => setItems(snapshot.docs.map((document) => {
      const data = document.data();
      return { id: document.id, name: String(data.name || ''), kind: data.kind as CatalogItem['kind'], description: String(data.description || ''), priceCentavos: Number(data.priceCentavos || 0), quoteOnly: data.quoteOnly === true, stock: Number(data.stock ?? -1), variants: Array.isArray(data.variants) ? data.variants.filter((item): item is string => typeof item === 'string') : [], imageUrl: String(data.imageUrl || ''), active: data.active === true };
    }).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name))), (cause) => setError(cause.message));
    const stopOrders = onSnapshot(collection(db, 'workspaces', workspace.id, 'orders'), (snapshot) => setOrders(snapshot.docs.map((document) => {
      const data = document.data();
      return { id: document.id, reference: String(data.reference || ''), itemName: String(data.itemName || ''), variant: String(data.variant || ''), quantity: Number(data.quantity || 1), totalCentavos: Number(data.totalCentavos || 0), quoteOnly: data.quoteOnly === true, status: String(data.status || 'draft'), contactName: String(data.contactName || 'Messenger customer'), paymentMethod: String(data.paymentMethod || ''), createdAt: data.createdAt as Timestamp | undefined, paidAt: data.paidAt as Timestamp | undefined };
    }).sort((left, right) => (right.createdAt?.toMillis() || 0) - (left.createdAt?.toMillis() || 0))), (cause) => setError(cause.message));
    const stopPayment = onSnapshot(collection(db, 'workspaces', workspace.id, 'connections'), (snapshot) => {
      const document = snapshot.docs.find((candidate) => candidate.id === 'paymongo');
      const data = document?.data();
      setPayment(document && data ? { status: String(data.status || ''), health: String(data.health || ''), mode: String(data.mode || ''), qrphEnabled: data.qrphEnabled === true, nativeGcashEnabled: data.nativeGcashEnabled === true, gcashAccountHint: String(data.gcashAccountHint || '') } : null);
    }, (cause) => setError(cause.message));
    return () => { stopItems(); stopOrders(); stopPayment(); };
  }, [workspace]);

  const metrics = useMemo(() => ({
    activeCards: items.filter((item) => item.active).length,
    openQuotes: orders.filter((order) => order.status === 'quote_requested').length,
    pending: orders.filter((order) => ['pending_payment', 'pending_gcash'].includes(order.status)).length,
    paid: orders.filter((order) => order.status === 'paid').reduce((sum, order) => sum + order.totalCentavos, 0),
  }), [items, orders]);

  const request = async (action: string, values: Record<string, unknown> = {}) => {
    if (!user || !workspace) throw new Error('Workspace unavailable.');
    const response = await fetch(`/api/commerce/${encodeURIComponent(action)}`, { method: 'POST', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: workspace.id, ...values }) });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  };

  const saveItem = async () => {
    if (!draft.name.trim()) return;
    setBusy('item'); setError(''); setNotice('');
    try {
      await request('item_upsert', { item: { id: draft.id, name: draft.name, kind: draft.kind, description: draft.description, priceCentavos: draft.quoteOnly ? 0 : Math.round(Number(draft.price) * 100), quoteOnly: draft.quoteOnly, stock: draft.stock === '' ? null : Number(draft.stock), variants: draft.variants.split(/[\n,]/).map((value) => value.trim()).filter(Boolean), imageUrl: draft.imageUrl, active: draft.active } });
      setDraft(emptyItem());
      setNotice('Catalog card saved. Messenger will use this verified item data immediately.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The catalog item could not be saved.'); }
    finally { setBusy(''); }
  };

  const editItem = (item: CatalogItem) => {
    setDraft({ id: item.id, name: item.name, kind: item.kind, description: item.description, price: item.quoteOnly ? '' : (item.priceCentavos / 100).toFixed(2), quoteOnly: item.quoteOnly, stock: item.stock < 0 ? '' : String(item.stock), variants: item.variants.join(', '), imageUrl: item.imageUrl, active: item.active });
    document.getElementById('commerce-item-editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const deleteItem = async (item: CatalogItem) => {
    if (!window.confirm(`Delete ${item.name}? Existing orders remain in the CRM.`)) return;
    setBusy(item.id); setError('');
    try { await request('item_delete', { itemId: item.id }); if (draft.id === item.id) setDraft(emptyItem()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The catalog item could not be deleted.'); }
    finally { setBusy(''); }
  };

  const connectPayment = async () => {
    if (!secretKey || !webhookSecret) return;
    setBusy('payment'); setError(''); setNotice('');
    try {
      await request('connect', { secretKey, webhookSecret, gcashNumber, gcashAccountName });
      setSecretKey(''); setWebhookSecret(''); setGcashNumber(''); setGcashAccountName('');
      setNotice('PayMongo QRPh verified. Signed payment confirmation is now active.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PayMongo could not be connected.'); }
    finally { setBusy(''); }
  };

  const disconnectPayment = async () => {
    if (!window.confirm('Disconnect PayMongo? New Messenger orders will stop offering QRPh checkout.')) return;
    setBusy('payment'); setError('');
    try { await request('disconnect'); setNotice('PayMongo disconnected.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'PayMongo could not be disconnected.'); }
    finally { setBusy(''); }
  };

  const markPaid = async (order: Order) => {
    if (!window.confirm(`Confirm that ${order.reference} was received in GCash? This will notify the customer.`)) return;
    setBusy(order.id); setError('');
    try { await request('mark_paid', { orderId: order.id }); setNotice(`${order.reference} marked paid and confirmation sent when the Messenger route was available.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The order could not be updated.'); }
    finally { setBusy(''); }
  };

  const copyWebhook = async () => {
    try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }
    catch { setError('Copy was blocked. Select the webhook URL and copy it manually.'); }
  };

  return (
    <div className="workspace-page commerce-page">
      <header className="workspace-page-heading"><div><span>Commerce CRM</span><h1>Sell inside the conversation.</h1><p>Own the catalog, build the order in Messenger, and let verified payment events update the CRM.</p></div></header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}
      {notice && <p className="commerce-notice"><Check aria-hidden="true" /> {notice}</p>}

      <section className="publishing-metrics" aria-label="Commerce performance">
        <article><ShoppingBag /><span>Messenger cards</span><strong>{metrics.activeCards}</strong><small>First 10 active cards publish in the catalog</small></article>
        <article><Boxes /><span>Quote requests</span><strong>{metrics.openQuotes}</strong><small>Ready for team pricing</small></article>
        <article><CreditCard /><span>Awaiting payment</span><strong>{metrics.pending}</strong><small>QRPh or native GCash</small></article>
        <article><ShieldCheck /><span>Verified revenue</span><strong>{money(metrics.paid)}</strong><small>Signed webhook or manual GCash confirmation</small></article>
      </section>

      <div className="commerce-layout">
        <section className="commerce-panel" id="commerce-item-editor">
          <header><span>Catalog card</span><h2>{draft.id ? 'Edit the offer.' : 'Add an offer.'}</h2><p>Only verified information saved here appears in deterministic Messenger cards.</p></header>
          <div className="commerce-form-grid">
            <label><span>Name</span><input value={draft.name} maxLength={80} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="PLA 3D printing" /></label>
            <label><span>Type</span><select value={draft.kind} onChange={(event) => setDraft((value) => ({ ...value, kind: event.target.value as CatalogItem['kind'] }))}><option value="service">Service</option><option value="product">Product</option><option value="material">Material</option></select></label>
            <label className="is-wide"><span>Description</span><textarea value={draft.description} maxLength={240} onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))} placeholder="What the customer needs to know before selecting." /></label>
            <label><span>Price · PHP</span><input type="number" min="1" step="0.01" disabled={draft.quoteOnly} value={draft.price} onChange={(event) => setDraft((value) => ({ ...value, price: event.target.value }))} placeholder={draft.quoteOnly ? 'Quotation only' : '899.00'} /></label>
            <label><span>Stock</span><input type="number" min="0" step="1" value={draft.stock} onChange={(event) => setDraft((value) => ({ ...value, stock: event.target.value }))} placeholder="Blank means unlimited" /></label>
            <label className="is-wide"><span>Options · maximum 3</span><input value={draft.variants} onChange={(event) => setDraft((value) => ({ ...value, variants: event.target.value }))} placeholder="Black, White, Custom color" /></label>
            <label className="is-wide"><span>Public HTTPS image URL</span><input type="url" value={draft.imageUrl} onChange={(event) => setDraft((value) => ({ ...value, imageUrl: event.target.value }))} placeholder="https://…/product.jpg" /></label>
          </div>
          <div className="commerce-checks"><label><input type="checkbox" checked={draft.quoteOnly} onChange={(event) => setDraft((value) => ({ ...value, quoteOnly: event.target.checked }))} /> Request a quotation instead of charging a fixed price</label><label><input type="checkbox" checked={draft.active} onChange={(event) => setDraft((value) => ({ ...value, active: event.target.checked }))} /> Publish this Messenger card</label></div>
          <footer><button type="button" className="commerce-primary" onClick={() => void saveItem()} disabled={busy === 'item' || !draft.name || (!draft.quoteOnly && !draft.price)}>{draft.id ? <Pencil /> : <Plus />}{busy === 'item' ? 'Saving…' : draft.id ? 'Save changes' : 'Add catalog card'}</button>{draft.id && <button type="button" onClick={() => setDraft(emptyItem())}><X /> Cancel edit</button>}</footer>
        </section>

        <section className="commerce-panel commerce-payment-panel">
          <header><span>Payments</span><h2>PayMongo QRPh.</h2><p>ORIN creates a hosted checkout and marks an order paid only after a signed PayMongo event.</p></header>
          {payment ? <div className="commerce-connection"><ShieldCheck /><div><strong>QRPh connected · {payment.mode}</strong><small>{payment.nativeGcashEnabled ? `Native GCash ready · ${payment.gcashAccountHint}` : 'Native GCash account not configured'}</small></div><em>Healthy</em></div> : <div className="commerce-connection is-pending"><CreditCard /><div><strong>Connection required</strong><small>Your active QRPh method still needs API and webhook credentials.</small></div></div>}
          <label><span>PayMongo secret API key</span><input type="password" autoComplete="off" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} placeholder="sk_live_…" /></label>
          <label><span>Webhook signing secret</span><input type="password" autoComplete="off" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} placeholder="From PayMongo Developers → Webhooks" /></label>
          <div className="commerce-webhook"><span>Webhook endpoint</span><code>{webhookUrl}</code><button type="button" onClick={() => void copyWebhook()}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}</button><small>Subscribe this endpoint only to <b>checkout_session.payment.paid</b>.</small></div>
          <div className="commerce-gcash"><strong>Optional native Messenger GCash</strong><p>Meta can present the transfer action, while ORIN keeps the order pending until you verify receipt.</p><label><span>GCash mobile number</span><input value={gcashNumber} onChange={(event) => setGcashNumber(event.target.value)} placeholder="09XXXXXXXXX" /></label><label><span>Account name</span><input value={gcashAccountName} onChange={(event) => setGcashAccountName(event.target.value)} placeholder="Business account name" /></label></div>
          <footer><button type="button" className="commerce-primary" onClick={() => void connectPayment()} disabled={busy === 'payment' || !secretKey || !webhookSecret}>{busy === 'payment' ? 'Verifying…' : payment ? 'Verify and replace' : 'Connect PayMongo'}</button>{payment && canAdmin && <button type="button" onClick={() => void disconnectPayment()} disabled={busy === 'payment'}>Disconnect</button>}</footer>
        </section>
      </div>

      <section className="commerce-catalog">
        <header><div><span>Catalog</span><h2>Messenger cards</h2></div><small>{items.filter((item) => item.active).length} active · {items.length} total</small></header>
        {items.length ? <div>{items.map((item) => <article key={item.id} className={item.active ? '' : 'is-disabled'}>{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span><Package /></span>}<div><em>{item.kind}</em><strong>{item.name}</strong><p>{item.description || 'No description'}</p><small>{item.quoteOnly ? 'Quotation only' : money(item.priceCentavos)}{item.stock >= 0 ? ` · ${item.stock} available` : ''}{item.variants.length ? ` · ${item.variants.join(', ')}` : ''}</small></div><div><button type="button" onClick={() => editItem(item)}><Pencil /> Edit</button>{canAdmin && <button type="button" onClick={() => void deleteItem(item)} disabled={busy === item.id}><Trash2 /> Delete</button>}</div></article>)}</div> : <div className="commerce-empty"><ShoppingBag /><strong>No catalog cards yet.</strong><p>Add the first service, product, or material above.</p></div>}
      </section>

      <section className="commerce-orders">
        <header><div><span>Order ledger</span><h2>Quotes and payments</h2></div><small>{orders.length} orders</small></header>
        {orders.length ? <div className="commerce-orders-table"><div className="commerce-orders-heading"><span>Order</span><span>Customer</span><span>Value</span><span>Status</span><span>Created</span><span /></div>{orders.map((order) => <article key={order.id}><span><strong>{order.reference}</strong><small>{order.itemName}{order.variant ? ` · ${order.variant}` : ''} × {order.quantity}</small></span><span>{order.contactName}</span><span>{order.quoteOnly ? 'Quote' : money(order.totalCentavos)}</span><span><em className={`is-${order.status}`}>{statusLabel(order.status)}</em></span><time>{order.createdAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Just now'}</time><span>{order.status === 'pending_gcash' && <button type="button" onClick={() => void markPaid(order)} disabled={busy === order.id}>Mark paid</button>}</span></article>)}</div> : <div className="commerce-empty"><Boxes /><strong>No orders yet.</strong><p>Messenger selections will appear here automatically.</p></div>}
      </section>
    </div>
  );
}
