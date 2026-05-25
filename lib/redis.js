/**
 * Upstash Redis (Vercel Marketplace integration). Legacy KV_* env names still supported.
 */

import { Redis } from '@upstash/redis';

let redis = null;
let initAttempted = false;

export function getRedisEnv() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''
  };
}

export function isRedisConfigured() {
  const { url, token } = getRedisEnv();
  return Boolean(url && token);
}

/** @deprecated alias */
export const isKvConfigured = isRedisConfigured;

export async function getRedis() {
  if (!isRedisConfigured()) return null;
  if (initAttempted) return redis;
  initAttempted = true;
  try {
    const { url, token } = getRedisEnv();
    redis = new Redis({ url, token });
  } catch (error) {
    console.warn('Upstash Redis unavailable:', error?.message || error);
    redis = null;
  }
  return redis;
}

export function getStoreBackend() {
  if (isRedisConfigured() && redis) return 'redis';
  if (isRedisConfigured()) return 'redis-pending';
  return 'memory';
}
