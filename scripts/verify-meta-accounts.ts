import assert from 'node:assert/strict';
import { mergeMetaPages, mergeMetaSubscriptionIds, type StoredMetaPage } from '../api/integrations/meta/callback';

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
console.log('Multiple Meta account merging verified.');
