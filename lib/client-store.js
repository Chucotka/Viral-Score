/**
 * Persistent client state: Upstash Redis when configured, else in-memory (per instance).
 */

import { getRedis } from './redis.js';

export { isRedisConfigured, isKvConfigured, getStoreBackend } from './redis.js';

const CLIENT_KEY_PREFIX = 'vs:client:';
const memoryClients = new Map();

export function normalizeClientId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\s+/g, '_').slice(0, 128);
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

  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`${CLIENT_KEY_PREFIX}${id}`);
      if (raw && typeof raw === 'object') {
        const client = hydrateClient(raw, id);
        memoryClients.set(id, client);
        return client;
      }
    } catch (error) {
      console.warn('Redis loadClient failed, using memory fallback:', error?.message || error);
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

  const redis = await getRedis();
  if (!redis) return;

  try {
    await redis.set(`${CLIENT_KEY_PREFIX}${id}`, serializeClient(hydrated));
  } catch (error) {
    console.warn('Redis saveClient failed:', error?.message || error);
  }
}

export async function ensureClientRecord(clientId) {
  return loadClient(clientId);
}
