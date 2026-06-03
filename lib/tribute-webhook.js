import crypto from 'node:crypto';
import { ensureClientRecord, saveClient, normalizeClientId } from './client-store.js';

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'viral_score_bot';
const PREMIUM_ACCESS_DAYS = Math.max(1, Number(process.env.PREMIUM_ACCESS_DAYS) || 30);

function getTributeSignature(req) {
  const raw = req.headers['x-tribute-signature'] || req.headers['trbt-signature'] || '';
  return Array.isArray(raw) ? raw[0] : String(raw || '');
}

export function verifyTributeSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex').toLowerCase();
  const provided = String(signatureHeader).replace(/^sha256=/i, '').trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

function parseTributePayload(body) {
  if (body?.event === 'payment.success' || body?.event === 'payment.refund') {
    return {
      event: body.event,
      productId: body.product_id != null ? String(body.product_id) : '',
      buyerId: Number(body.buyer_id) || null,
      buyerUsername: String(body.buyer_username || ''),
      amount: Number(body.amount) || 0,
      currency: String(body.currency || '')
    };
  }

  if (body?.name === 'new_digital_product') {
    const nested = body.payload || {};
    return {
      event: 'payment.success',
      productId: nested.product_id != null ? String(nested.product_id) : '',
      buyerId: Number(nested.telegram_user_id) || null,
      buyerUsername: '',
      amount: Number(nested.amount) || 0,
      currency: String(nested.currency || '')
    };
  }

  if (body?.name === 'digital_product_refund') {
    const nested = body.payload || {};
    return {
      event: 'payment.refund',
      productId: nested.product_id != null ? String(nested.product_id) : '',
      buyerId: Number(nested.telegram_user_id) || null,
      buyerUsername: '',
      amount: Number(nested.amount) || 0,
      currency: String(nested.currency || '')
    };
  }

  return null;
}

async function grantPremiumAccess(clientId) {
  const normalized = normalizeClientId(clientId);
  if (!normalized) return null;
  const client = await ensureClientRecord(normalized);
  if (!client) return null;
  client.accessUnlocked = true;
  client.lastPaymentMethod = 'tribute';
  client.lastSeenAt = new Date().toISOString();
  const nowMs = Date.now();
  const currentMs = client.accessExpiresAt ? new Date(client.accessExpiresAt).getTime() : 0;
  const baseMs = Math.max(nowMs, Number.isFinite(currentMs) ? currentMs : 0);
  client.accessExpiresAt = new Date(baseMs + PREMIUM_ACCESS_DAYS * 86400000).toISOString();
  await saveClient(client);
  return {
    clientId: normalized,
    accessExpiresAt: client.accessExpiresAt
  };
}

async function sendTelegramSuccessMessage(buyerId) {
  if (!BOT_TOKEN || !buyerId) return;
  const appUrl = `https://t.me/${BOT_USERNAME}/app`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: buyerId,
      text: '✅ Готово! Твой Viral Score открыт.\n\nАнализируй контент здесь 👇',
      reply_markup: {
        inline_keyboard: [[{
          text: 'Открыть Viral Score',
          url: appUrl
        }]]
      }
    })
  }).catch((err) => {
    console.error('[tribute-webhook] telegram send failed', err);
  });
}

export async function handleTributeWebhookRequest(req, rawBody) {
  const secret = process.env.TRIBUTE_WEBHOOK_SECRET || '';
  const signature = getTributeSignature(req);

  if (!verifyTributeSignature(rawBody, signature, secret)) {
    console.warn('[tribute-webhook] invalid signature, ignoring');
    return { ok: true };
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.warn('[tribute-webhook] invalid JSON, ignoring');
    return { ok: true };
  }

  const parsed = parseTributePayload(body);
  if (!parsed) {
    console.log('[tribute-webhook] unhandled event', body?.event || body?.name || 'unknown');
    return { ok: true };
  }

  if (parsed.event === 'payment.success' && parsed.buyerId) {
    const clientId = `tg:${parsed.buyerId}`;
    const granted = await grantPremiumAccess(clientId);
    console.log('[tribute-webhook] payment.success', {
      buyerId: parsed.buyerId,
      buyerUsername: parsed.buyerUsername,
      productId: parsed.productId,
      amount: parsed.amount,
      currency: parsed.currency,
      clientId,
      accessExpiresAt: granted?.accessExpiresAt
    });
    await sendTelegramSuccessMessage(parsed.buyerId);
  } else if (parsed.event === 'payment.refund') {
    console.log('[tribute-webhook] payment.refund', parsed);
  }

  return { ok: true };
}
