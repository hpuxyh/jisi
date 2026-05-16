// 调后端，路径都是相对路径，前端与 API 同域名

export async function fetchModels() {
  const r = await fetch('/api/models');
  if (!r.ok) throw new Error('获取模型列表失败');
  return r.json(); // { models: [{ id, name, color, model }] }
}

export async function fetchQuota() {
  const r = await fetch('/api/quota');
  if (!r.ok) throw new Error('获取配额失败');
  return r.json(); // { used, limit, remaining, resetAt }
}

export async function ask({ question, systemPrompt, modelIds, summaryModelId, history, dimensions }) {
  const r = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, systemPrompt, modelIds, summaryModelId, history, dimensions }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${r.status}`);
    err.code = data?.error;
    err.quotaExceeded = r.status === 429;
    err.maxTurnsReached = data?.error === 'MAX_TURNS_REACHED';
    err.data = data;
    throw err;
  }
  return data; // { results, summary, quota }
}
