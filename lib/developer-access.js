import { normalizeClientId } from './client-store.js';

const DEVELOPER_CLIENT_IDS = new Set(
  String(process.env.DEVELOPER_CLIENT_IDS || '')
    .split(',')
    .map((id) => normalizeClientId(id))
    .filter(Boolean)
);

/** Server-only allowlist: unlimited quota + premium features, never exposed to the client. */
export function isDeveloperClient(clientId) {
  const id = normalizeClientId(clientId);
  return Boolean(id && DEVELOPER_CLIENT_IDS.has(id));
}

export function hasPremiumAccess(client, clientId) {
  return Boolean(client?.accessUnlocked) || isDeveloperClient(clientId);
}

/** Count toward free tier only for real, non-degraded analyses. */
export function shouldBillFreeAnalysis(client, clientId, { analysisDegraded = false } = {}) {
  if (hasPremiumAccess(client, clientId)) return false;
  if (analysisDegraded) return false;
  return true;
}
