/**
 * Simple per-client rate limits (Upstash Redis when available, else in-memory).
 */

import { getRedis, isRedisConfigured } from './redis.js';

const memoryBuckets = new Map();

function currentWindowKey(scope, clientId) {
  const hour = Math.floor(Date.now() / 3600000);
  return `vs:rl:${scope}:${clientId}:${hour}`;
}

const DEFAULT_LIMITS = {
  analyze: Math.max(1, Number(process.env.RATE_LIMIT_ANALYZE_PER_HOUR || 40)),
  stars_invoice: Math.max(1, Number(process.env.RATE_LIMIT_STARS_INVOICE_PER_HOUR || 20))
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
  const redis = await getRedis();

  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, 3700);
      }
      if (count > limit) {
        const error = new Error('Too many requests. Please wait and try again.');
        error.statusCode = 429;
        throw error;
      }
      return;
    } catch (error) {
      if (error?.statusCode === 429) throw error;
      console.warn('Redis rate limit failed, using memory:', error?.message || error);
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

export { isRedisConfigured };
