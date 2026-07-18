import assert from 'node:assert/strict';
import { collectMetaPages, mergeMetaPages, mergeMetaSubscriptionIds, type StoredMetaPage } from '../api/integrations/meta/callback';
import { metaOAuthScopes } from '../api/integrations/meta/start';

const page = (id: string, token: string, instagram: StoredMetaPage['instagramBusinessAccount'] = null): StoredMetaPage => ({
  id,
  name: `Page ${id}`,
  accessToken: token,
  tasks: ['MESSAGING'],
  instagramBusinessAccount: instagram,
});

const existing = page('page_1', 'old_access_token_123456789', { id: 'ig_1', username: 'first.shop' });
const merged = mergeMetaPages(
  [existing],
  [page('page_1', 'new_access_token_123456789'), page('page_2', 'second_access_token_123456')],
);
assert.equal(merged.length, 2);
assert.equal(merged[0].accessToken, 'new_access_token_123456789');
assert.equal(merged[0].instagramBusinessAccount?.username, 'first.shop');

assert.deepEqual(
  mergeMetaSubscriptionIds(['page_1'], ['page_2'], ['page_2'], ['page_2'], []),
  { ready: ['page_1', 'page_2'], failed: [] },
);
const discovered = await collectMetaPages(async (after) => after
  ? { data: [{ id: 'page_3', name: 'Page 3', access_token: 'token_3' }] }
  : { data: [{ id: 'page_1', name: 'Page 1', access_token: 'token_1' }, { id: 'page_2', name: 'Page 2', access_token: 'token_2' }], paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'cursor_2' } } });
assert.deepEqual(discovered.map((item) => item.id), ['page_1', 'page_2', 'page_3']);
assert(metaOAuthScopes('').includes('pages_manage_posts'));
assert(metaOAuthScopes('').includes('pages_read_engagement'));
assert(!metaOAuthScopes('').includes('instagram_content_publish'));
console.log('Multiple Meta account merging verified.');
