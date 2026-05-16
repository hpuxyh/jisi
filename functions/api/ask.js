import {
  MODELS, DAILY_LIMIT,
  getBeijingDate, getClientIp, quotaKey,
  callModel, buildModelMessages, withTimeout, json,
} from '../_shared.js';

const MODEL_TIMEOUT_MS = 300000;  // 单模型最长 5 分钟（深度思考型 + 多轮上下文）
const SUMMARY_TIMEOUT_MS = 120000; // 对比分析最长 2 分钟
const MAX_TURNS = 10;             // 单对话最大轮数

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

  // 1. 拿 IP + 日期 + 当日用量
  const ip = getClientIp(request);
  const date = getBeijingDate();
  const qKey = quotaKey(ip, date);
  const used = parseInt(await env.QUOTA_KV.get(qKey)) || 0;

  if (used >= DAILY_LIMIT) {
    return json({
      error: 'QUOTA_EXCEEDED',
      message: `今日 ${DAILY_LIMIT} 次配额已用完，明天再来吧 👋`,
      used,
      limit: DAILY_LIMIT,
    }, 429);
  }

  // 2. 解析请求
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }
  const { question, systemPrompt, modelIds, summaryModelId, history, dimensions } = body || {};

  if (!question || typeof question !== 'string' || !question.trim()) {
    return json({ error: 'EMPTY_QUESTION' }, 400);
  }
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return json({ error: 'NO_MODELS_SELECTED' }, 400);
  }

  // history 校验：必须是数组，长度 <= MAX_TURNS - 1（留 1 个位置给新提问）
  const safeHistory = Array.isArray(history) ? history : [];
  if (safeHistory.length >= MAX_TURNS) {
    return json({
      error: 'MAX_TURNS_REACHED',
      message: `本对话已达 ${MAX_TURNS} 轮上限，请新建对话继续`,
      limit: MAX_TURNS,
    }, 400);
  }

  // 3. 解析要调用的模型
  const targets = MODELS.filter(m => modelIds.includes(m.id));
  if (targets.length === 0) {
    return json({ error: 'NO_VALID_MODELS' }, 400);
  }

  // 4. 先记一次用量（即便后面失败，也算一次提问，防刷）
  const newUsed = used + 1;
  await env.QUOTA_KV.put(qKey, String(newUsed), { expirationTtl: 90000 }); // 25 小时

  // 5. 并行调所有模型，每个独立超时，失败的不影响成功的
  // 每个模型只看到自己之前的回答 + 全部历史问题
  const results = await Promise.all(
    targets.map(async (m) => {
      try {
        const messages = buildModelMessages(m.id, safeHistory, question);
        const r = await withTimeout(
          callModel(m, messages, systemPrompt, env),
          MODEL_TIMEOUT_MS,
          m.name,
        );
        return { id: m.id, name: m.name, ok: true, text: r.text, duration: r.duration, tokens: r.tokens };
      } catch (e) {
        return { id: m.id, name: m.name, ok: false, error: e?.message || String(e) };
      }
    })
  );

  // 6. 至少 2 个成功 → 让对比分析模型出对比
  let summary = null;
  const successful = results.filter(r => r.ok);
  if (successful.length >= 2 && summaryModelId) {
    const summaryConfig = MODELS.find(m => m.id === summaryModelId);
    if (summaryConfig) {
      try {
        const summaryRes = await withTimeout(
          callModel(
            summaryConfig,
            buildSummaryPrompt(question, successful, dimensions),
            null, // 对比分析不带用户的 system prompt
            env,
            { maxTokens: 2000 },
          ),
          SUMMARY_TIMEOUT_MS,
          '对比分析',
        );
        summary = {
          ok: true,
          modelName: summaryConfig.name,
          text: summaryRes.text,
          duration: summaryRes.duration,
        };
      } catch (e) {
        summary = { ok: false, error: e?.message || String(e), modelName: summaryConfig.name };
      }
    }
  } else if (successful.length < 2 && results.length >= 2) {
    summary = {
      ok: false,
      insufficient: true,
      successful: successful.map(r => ({ id: r.id, name: r.name })),
    };
  }

  // 7. 返回完整结果
  return json({
    results,
    summary,
    quota: {
      used: newUsed,
      limit: DAILY_LIMIT,
      remaining: Math.max(0, DAILY_LIMIT - newUsed),
    },
  });
}
