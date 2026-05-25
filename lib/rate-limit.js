/**
 * Simple per-client rate limits (KV when available, else in-memory).
 */

const memoryBuckets = new Map();
let kvClient = null;
let kvInitAttempted = false;

function isKvConfigured() {
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
  } catch {
    kvClient = null;
  }
  return kvClient;
}

function currentWindowKey(scope, clientId) {
  const hour = Math.floor(Date.now() / 3600000);
  return `vs:rl:${scope}:${clientId}:${hour}`;
}

const DEFAULT_LIMITS = {
  analyze: Math.max(1, Number(process.env.RATE_LIMIT_ANALYZE_PER_HOUR || 40))
};

/**
 * @returns {Promise<void>}
 * @throws Error with statusCode 429 when limit exceeded
 */
export async function assertRateLimit(clientId, scope = 'analyze') {
  const id = String(clientId || '').trim().slice(0, 128);
  if (!id) return;

  const limit = DEFAULT_LIMITS[scope] || 40;
  const key = currentWindowKey(scope, id);
  const kv = await getKv();

  if (kv) {
    try {
      const count = await kv.incr(key);
      if (count === 1) {
        await kv.expire(key, 3700);
      }
      if (count > limit) {
        const error = new Error('Too many requests. Please wait and try again.');
        error.statusCode = 429;
        throw error;
      }
      return;
    } catch (error) {
      if (error?.statusCode === 429) throw error;
      console.warn('KV rate limit failed, using memory:', error?.message || error);
    }
  }

  const count = (memoryBuckets.get(key) || 0) + 1;
  memoryBuckets.set(key, count);
  if (count > limit) {
    const error = new Error('Too many requests. Please wait and try again.');
    error.statusCode = 429;
    throw error;
  }
}
