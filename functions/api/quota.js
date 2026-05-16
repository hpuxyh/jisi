import {
  DAILY_LIMIT, getBeijingDate, getClientIp, quotaKey, json,
} from '../_shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.QUOTA_KV) {
    return json({ error: 'KV 未绑定，请在 Pages 设置里绑定 QUOTA_KV' }, 500);
  }

  const ip = getClientIp(request);
  const date = getBeijingDate();
  const used = parseInt(await env.QUOTA_KV.get(quotaKey(ip, date))) || 0;

  return json({
    used,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - used),
    resetAt: '北京时间 00:00',
  });
}
