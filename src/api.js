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

// 流式 ask：通过 SSE 边收边推送事件
// onEvent({ event, data }) 会被多次回调
export async function askStream({ question, systemPrompt, modelIds, summaryModelId, history, dimensions, onEvent, signal }) {
  const r = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ question, systemPrompt, modelIds, summaryModelId, history, dimensions }),
    signal,
  });
  if (!r.ok) {
    // 非 200：尝试当 JSON 解析错误
    const data = await r.json().catch(() => ({}));
    const err = new Error(data?.message || data?.error || `HTTP ${r.status}`);
    err.code = data?.error;
    err.quotaExceeded = r.status === 429;
    err.maxTurnsReached = data?.error === 'MAX_TURNS_REACHED';
    err.data = data;
    throw err;
  }
  if (!r.body) throw new Error('服务端无响应体');

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 事件以 \n\n 分隔
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let eventName = 'message';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload;
        try { payload = JSON.parse(dataLine); } catch (e) { continue; }
        try { onEvent?.(eventName, payload); } catch (e) {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
}
