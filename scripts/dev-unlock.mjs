import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const clientId = process.argv[2];

if (!clientId) {
  console.error('usage: node dev-unlock.mjs <clientId>');
  process.exit(1);
}

const redis = new Redis({ url, token });
const key = `vs:client:${clientId}`;
const raw = await redis.get(key);
if (!raw) {
  console.error('client not found:', key);
  process.exit(1);
}
const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
client.accessUnlocked = true;
client.usageCount = 0;
client.lastPaymentMethod = 'dev';
await redis.set(key, JSON.stringify(client));
const check = await redis.get(key);
const after = typeof check === 'string' ? JSON.parse(check) : check;
console.log('updated:', { clientId: after.clientId, usageCount: after.usageCount, accessUnlocked: after.accessUnlocked });
