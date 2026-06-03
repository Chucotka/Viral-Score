import { normalizeClientId } from './client-store.js';

const DEVELOPER_CLIENT_IDS = new Set(
  String(process.env.DEVELOPER_CLIENT_IDS || '')
    .split(',')
    .map((id) => normalizeClientId(id))
    .filter(Boolean)
);

/** Numeric Telegram user IDs (without tg: prefix) — maps to clientId tg:<id> in Mini App. */
const TELEGRAM_DEV_USER_IDS = new Set(
  String(process.env.TELEGRAM_DEV_USER_IDS || '')
    .split(',')
    .map((id) => String(id || '').trim())
    .filter(Boolean)
);

/** Server-only allowlist: unlimited quota + premium features, never exposed to the client. */
export function isDeveloperClient(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return false;
  if (DEVELOPER_CLIENT_IDS.has(id)) return true;
  const tgMatch = id.match(/^tg:(\d+)$/i);
  if (tgMatch && TELEGRAM_DEV_USER_IDS.has(tgMatch[1])) return true;
  return false;
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
