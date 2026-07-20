export const DEFAULT_META_AD_ACCOUNT_ID = "act_1628380711555551";
export const DEFAULT_META_AD_ACCOUNT_NAME = "Ofiprof";

export function primaryMetaAdAccountId(env = process.env) {
  return String(env.META_PRIMARY_AD_ACCOUNT_ID || DEFAULT_META_AD_ACCOUNT_ID).trim();
}

export function selectPrimaryMetaAdAccount(accounts = [], configuredId = primaryMetaAdAccountId()) {
  const accountId = String(configuredId ?? "").trim();
  if (!accountId) return null;
  return accounts.find((account) => (
    String(account?.id ?? "").trim() === accountId &&
    String(account?.currency ?? "").toUpperCase() === "USD"
  )) ?? null;
}

export function hasMetaAdsActivity(metrics = {}) {
  return (
    Number(metrics.spend) > 0 ||
    Number(metrics.impressions) > 0 ||
    Number(metrics.clicks) > 0 ||
    Number(metrics.conversions) > 0 ||
    Number(metrics.purchaseValue) > 0
  );
}

export function shouldReplaceLegacyMetaAdsMetrics(legacy, replacement) {
  return Boolean(replacement) && (hasMetaAdsActivity(replacement) || !hasMetaAdsActivity(legacy));
}

export function metaSpendInArs(metrics, fallbackUsdArsRate = 1500) {
  if (metrics?.isUnavailable) return 0;

  const spend = Number(metrics?.spend) || 0;
  if (spend <= 0) return 0;

  const currency = String(metrics?.currency ?? "").toUpperCase();
  if (currency !== "USD") return spend;

  const storedRate = Number(metrics?.usdArsRate) || 0;
  const rate = storedRate > 0 ? storedRate : Math.max(1, Number(fallbackUsdArsRate) || 1500);
  return spend * rate;
}
