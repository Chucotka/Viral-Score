const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';

export const FREE_TIER_LIMIT = Math.max(0, Number(process.env.FREE_TIER_LIMIT) || 3);
export const ADMIN_SETUP_TOKEN = String(process.env.ADMIN_SETUP_TOKEN || '').trim();

const BILLING_MODES = new Set(['stars', 'tribute', 'both']);

function normalizeBillingMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return BILLING_MODES.has(mode) ? mode : '';
}

export function getDefaultBillingMode() {
  const configured = normalizeBillingMode(process.env.BILLING_MODE);
  if (configured) return configured;
  const hasTribute = Boolean(String(process.env.TRIBUTE_URL || '').trim());
  if (BOT_TOKEN && hasTribute) return 'both';
  if (BOT_TOKEN) return 'stars';
  if (hasTribute) return 'tribute';
  return 'both';
}

/** Public app config — safe to expose to all clients (no secrets). */
export function getPublicAppConfig() {
  return {
    botUsername: String(process.env.BOT_USERNAME || 'viral_score_bot').trim(),
    freeLimit: FREE_TIER_LIMIT,
    billingMode: getDefaultBillingMode(),
    starsPrice: Math.max(1, Number(process.env.STARS_MONTHLY_PRICE) || 350),
    tributeUrl: String(process.env.TRIBUTE_URL || '').trim(),
    cardCheckoutUrl: String(process.env.CARD_CHECKOUT_URL || '').trim(),
    premiumRubMonthly: Math.max(0, Number(process.env.PREMIUM_RUB_MONTHLY) || 490)
  };
}

export function isValidAdminSetupToken(token) {
  if (!ADMIN_SETUP_TOKEN) return false;
  return String(token || '').trim() === ADMIN_SETUP_TOKEN;
}
