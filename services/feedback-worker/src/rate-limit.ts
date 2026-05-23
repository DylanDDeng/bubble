export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

const PER_IP_HOUR = 3;
const PER_IP_DAY = 10;
const GLOBAL_HOUR = 50;

export async function checkRateLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  const now = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);
  const dayBucket = Math.floor(now / 86_400_000);

  const hourKey = `r:ip:${ip}:h${hourBucket}`;
  const dayKey = `r:ip:${ip}:d${dayBucket}`;
  const globalKey = `r:global:h${hourBucket}`;

  const [hourCount, dayCount, globalCount] = await Promise.all([
    readCount(kv, hourKey),
    readCount(kv, dayKey),
    readCount(kv, globalKey),
  ]);

  if (hourCount >= PER_IP_HOUR) {
    return { allowed: false, reason: `Too many requests this hour (limit ${PER_IP_HOUR}).` };
  }
  if (dayCount >= PER_IP_DAY) {
    return { allowed: false, reason: `Too many requests today (limit ${PER_IP_DAY}).` };
  }
  if (globalCount >= GLOBAL_HOUR) {
    return { allowed: false, reason: "Service is busy, please try again later." };
  }

  await Promise.all([
    kv.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 86_400 }),
    kv.put(globalKey, String(globalCount + 1), { expirationTtl: 3600 }),
  ]);

  return { allowed: true };
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
  const v = await kv.get(key);
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
