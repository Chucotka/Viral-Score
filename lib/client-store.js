/**
 * Persistent client state: Vercel KV / Upstash when configured, else in-memory (per instance).
 */

const CLIENT_KEY_PREFIX = 'vs:client:';
const memoryClients = new Map();

let kvClient = null;
let kvInitAttempted = false;

export function normalizeClientId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\s+/g, '_').slice(0, 128);
}

export function isKvConfigured() {
  return Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
    || (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  );
}

async function getKv() {
  if (!isKvConfigured()) return null;
  if (kvInitAttempted) return kvClient;
  kvInitAttempted = true;
  try {
    const { kv } = await import('@vercel/kv');
    kvClient = kv;
  } catch (error) {
    console.warn('Vercel KV unavailable, using in-memory client store:', error?.message || error);
    kvClient = null;
  }
  return kvClient;
}

export function createDefaultClient(clientId) {
  return {
    clientId,
    usageCount: 0,
    accessUnlocked: false,
    lastSeenAt: null,
    lastPaymentMethod: '',
    lastAnalysis: null,
    history: [],
    analysisIds: []
  };
}

function serializeClient(client) {
  const analysisIds = client.analysisIds instanceof Set
    ? [...client.analysisIds]
    : (Array.isArray(client.analysisIds) ? client.analysisIds : []);
  return {
    clientId: client.clientId,
    usageCount: Number(client.usageCount) || 0,
    accessUnlocked: Boolean(client.accessUnlocked),
    lastSeenAt: client.lastSeenAt || null,
    lastPaymentMethod: String(client.lastPaymentMethod || ''),
    lastAnalysis: client.lastAnalysis || null,
    history: Array.isArray(client.history) ? client.history : [],
    analysisIds
  };
}

function hydrateClient(raw, clientId) {
  const base = createDefaultClient(clientId);
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}), clientId };
  merged.analysisIds = new Set(
    Array.isArray(merged.analysisIds) ? merged.analysisIds.map(String) : []
  );
  merged.usageCount = Number(merged.usageCount) || 0;
  merged.accessUnlocked = Boolean(merged.accessUnlocked);
  merged.history = Array.isArray(merged.history) ? merged.history : [];
  return merged;
}

export async function loadClient(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;

  const kv = await getKv();
  if (kv) {
    try {
      const raw = await kv.get(`${CLIENT_KEY_PREFIX}${id}`);
      if (raw && typeof raw === 'object') {
        const client = hydrateClient(raw, id);
        memoryClients.set(id, client);
        return client;
      }
    } catch (error) {
      console.warn('KV loadClient failed, using memory fallback:', error?.message || error);
    }
  }

  if (memoryClients.has(id)) {
    return memoryClients.get(id);
  }

  const client = hydrateClient(null, id);
  memoryClients.set(id, client);
  return client;
}

export async function saveClient(client) {
  const id = normalizeClientId(client?.clientId);
  if (!id) return;
  const hydrated = hydrateClient(serializeClient({ ...client, clientId: id }), id);
  memoryClients.set(id, hydrated);

  const kv = await getKv();
  if (!kv) return;

  try {
    await kv.set(`${CLIENT_KEY_PREFIX}${id}`, serializeClient(hydrated));
  } catch (error) {
    console.warn('KV saveClient failed:', error?.message || error);
  }
}

export async function ensureClientRecord(clientId) {
  const client = await loadClient(clientId);
  return client;
}

export function getStoreBackend() {
  if (isKvConfigured() && kvClient) return 'kv';
  if (isKvConfigured()) return 'kv-pending';
  return 'memory';
}
