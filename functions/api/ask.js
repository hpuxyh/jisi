import {
  MODELS, DAILY_LIMIT,
  getBeijingDate, getClientIp, quotaKey,
  callModelStream, buildModelMessages, json,
} from '../_shared.js';

const MAX_TURNS = 10; // 单对话最大轮数

const DEFAULT_DIMENSIONS = [
  { title: '核心共识', hint: '所有模型一致的关键观点（如果没有就写"无明显共识"）' },
  { title: '主要分歧', hint: '观点上的明显差异，标注是哪些模型的立场' },
  { title: '角度与深度差异', hint: '谁更聚焦哪个维度、谁更深入' },
  { title: '风格差异', hint: '表达方式上的特征对比' },
];

function buildSummaryPrompt(question, results, dimensions) {
  const dims = (Array.isArray(dimensions) && dimensions.length > 0)
    ? dimensions.filter(d => d?.title?.trim())
    : DEFAULT_DIMENSIONS;
  const sections = dims.map(d => {
    const hint = (d.hint || '').trim();
    return `## ${d.title.trim()}\n${hint || '（按此维度分析）'}`;
  }).join('\n\n');
  return `下面是 ${results.length} 个不同 AI 模型对同一个问题的回答。请客观分析它们的核心差异。

**问题：** ${question}

${results.map(r => `**${r.name} 的回答：**\n${r.text}`).join('\n\n---\n\n')}

请按以下结构输出（每节简洁有力，不要冗长）：

${sections}

每节 2-4 句话即可。中文输出。`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.QUOTA_KV) {
    return json({ error: 'KV 未绑定，请在 Pages 设置里绑定 QUOTA_KV' }, 500);
  }

  const ip = getClientIp(request);
  const date = getBeijingDate();
  const qKey = quotaKey(ip, date);
  const used = parseInt(await env.QUOTA_KV.get(qKey)) || 0;

  if (used >= DAILY_LIMIT) {
    return json({
      error: 'QUOTA_EXCEEDED',
      message: `今日 ${DAILY_LIMIT} 次配额已用完，明天再来吧 👋`,
      used, limit: DAILY_LIMIT,
    }, 429);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'INVALID_JSON' }, 400); }
  const { question, systemPrompt, modelIds, summaryModelId, history, dimensions } = body || {};

  if (!question || typeof question !== 'string' || !question.trim()) return json({ error: 'EMPTY_QUESTION' }, 400);
  if (!Array.isArray(modelIds) || modelIds.length === 0) return json({ error: 'NO_MODELS_SELECTED' }, 400);

  const safeHistory = Array.isArray(history) ? history : [];
  if (safeHistory.length >= MAX_TURNS) {
    return json({
      error: 'MAX_TURNS_REACHED',
      message: `本对话已达 ${MAX_TURNS} 轮上限，请新建对话继续`,
      limit: MAX_TURNS,
    }, 400);
  }

  const targets = MODELS.filter(m => modelIds.includes(m.id));
  if (targets.length === 0) return json({ error: 'NO_VALID_MODELS' }, 400);

  // 先记一次用量（即便后面失败，也算一次提问，防刷）
  const newUsed = used + 1;
  await env.QUOTA_KV.put(qKey, String(newUsed), { expirationTtl: 90000 });

  // —— SSE 流式响应 ——
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (e) { /* ignore */ }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch (e) {}
      };

      // 立即推一次配额（前端可以马上更新计数）
      send('quota', { used: newUsed, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - newUsed) });

      // 并行调所有模型
      const modelPromises = targets.map(async (m) => {
        send('model_start', { modelId: m.id });
        try {
          const messages = buildModelMessages(m.id, safeHistory, question);
          const r = await callModelStream(m, messages, systemPrompt, env, (chunk) => {
            send('model_chunk', { modelId: m.id, text: chunk });
          });
          send('model_done', { modelId: m.id, text: r.text, duration: r.duration, tokens: r.tokens });
          return { id: m.id, name: m.name, ok: true, text: r.text };
        } catch (e) {
          send('model_error', { modelId: m.id, error: e?.message || String(e) });
          return { id: m.id, name: m.name, ok: false, error: e?.message || String(e) };
        }
      });
      const results = await Promise.all(modelPromises);

      // 对比分析
      const successful = results.filter(r => r.ok);
      if (successful.length >= 2 && summaryModelId) {
        const summaryConfig = MODELS.find(m => m.id === summaryModelId);
        if (summaryConfig) {
          send('summary_start', { modelName: summaryConfig.name });
          try {
            const r = await callModelStream(
              summaryConfig,
              buildSummaryPrompt(question, successful, dimensions),
              null,
              env,
              (chunk) => send('summary_chunk', { text: chunk }),
              { maxTokens: 2000 },
            );
            send('summary_done', { text: r.text, duration: r.duration, modelName: summaryConfig.name });
          } catch (e) {
            send('summary_error', { error: e?.message || String(e), modelName: summaryConfig.name });
          }
        }
      } else if (successful.length < 2 && results.length >= 2) {
        send('summary_insufficient', { successful: successful.map(r => ({ id: r.id, name: r.name })) });
      }

      send('end', {});
      close();
    },
    cancel() { /* 客户端断开时清理 */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
