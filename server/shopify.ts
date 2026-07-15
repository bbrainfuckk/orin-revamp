export function normalizeShopDomain(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(trimmed) || trimmed.length > 120) throw new Error('INVALID_SHOP');
  return trimmed;
}
