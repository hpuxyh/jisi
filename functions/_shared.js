// 服务端模型配置：endpoint / provider / 取哪个环境变量
// 改模型时只改这一处
export const MODELS = [
  {
    id: 'claude',
    name: 'Claude',
    color: '#c97a4a',
    model: 'claude-sonnet-4-6',
    provider: 'openai', // NewAPI 是 OpenAI 兼容格式
    endpoint: 'https://api.yz.rs/v1/chat/completions',
    keyEnv: 'CLAUDE_KEY',
  },
  {
    id: 'gpt',
    name: 'GPT',
    color: '#10a37f',
    model: 'gpt-5.5',
    provider: 'openai',
    endpoint: 'https://aihubmix.com/v1/chat/completions',
    keyEnv: 'GPT_KEY',
    tokensParam: 'max_completion_tokens', // GPT-5+ / o1 / o3 等新模型必须用这个字段
    maxTokens: 16000, // 推理模型：思考本身消耗 token，需要大额度
  },
  {
    id: 'gemini',
    name: 'Gemini',
    color: '#ec4899',
    model: 'gemini-3.1-flash-lite',
    provider: 'openai',
    endpoint: 'https://aihubmix.com/v1/chat/completions',
    keyEnv: 'GEMINI_KEY',
  },
  {
    id: 'doubao',
    name: '豆包',
    color: '#2563eb',
    model: 'doubao-seed-1-8-251228',
    provider: 'openai',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    keyEnv: 'DOUBAO_KEY',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    color: '#3b6bd9',
    model: 'deepseek-chat',
    provider: 'openai',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    keyEnv: 'DEEPSEEK_KEY',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    color: '#06b6d4',
    model: 'kimi-k2.6',
    provider: 'openai',
    endpoint: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    keyEnv: 'KIMI_KEY',
  },
  {
    id: 'yuanbao',
    name: '元宝',
    color: '#e11d48',
    model: 'hy3-preview',
    provider: 'openai',
    endpoint: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    keyEnv: 'YUANBAO_KEY',
  },
  {
    id: 'zhipu',
    name: '智谱',
    color: '#8b5cf6',
    model: 'glm-5.1',
    provider: 'openai',
    endpoint: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    keyEnv: 'ZHIPU_KEY',
  },
];

export const DAILY_LIMIT = 100;

// 取北京日期，配额按北京时间 0 点重置
export function getBeijingDate() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().split('T')[0]; // YYYY-MM-DD
}

// 取 IP（Cloudflare 提供）
export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

export function quotaKey(ip, date) {
  return `q:${ip}:${date}`;
}

// JSON 响应
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// 拼 system prompt
export function buildSystemMessage(sp) {
  if (!sp) return '';
  const parts = [];
  if (sp.role?.trim()) parts.push(`# 角色\n${sp.role.trim()}`);
  if (sp.context?.trim()) parts.push(`# 背景\n${sp.context.trim()}`);
  if (sp.instructions?.trim()) parts.push(`# 要求\n${sp.instructions.trim()}`);
  return parts.join('\n\n');
}

// 给某个模型按历史拼 messages 数组（每个模型只看到 user 提问 + 自己的回答）
export function buildModelMessages(modelId, history, newQuestion) {
  const messages = [];
  for (const turn of (history || [])) {
    if (!turn?.question) continue;
    messages.push({ role: 'user', content: turn.question });
    const ans = turn.responses?.[modelId];
    if (typeof ans === 'string' && ans.trim()) {
      messages.push({ role: 'assistant', content: ans });
    }
    // 该模型那一轮失败或没参与：跳过 assistant，避免发送空内容
  }
  messages.push({ role: 'user', content: newQuestion });
  return messages;
}

// 调用单个模型，统一返回 { text, duration, tokens? }
// promptOrMessages: 字符串（单轮）或 [{role, content}] 数组（多轮）
export async function callModel(config, promptOrMessages, systemPrompt, env, options = {}) {
  const startTime = Date.now();
  const apiKey = env[config.keyEnv];
  if (!apiKey) throw new Error(`服务端未配置 ${config.name} 的 Key`);

  const systemMsg = buildSystemMessage(systemPrompt);
  const maxTokens = options.maxTokens || config.maxTokens || 2500;

  // 归一化：把字符串包成单条 user 消息
  const inputMessages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: 'user', content: promptOrMessages }];

  if (config.provider === 'anthropic') {
    const body = {
      model: config.model,
      max_tokens: maxTokens,
      messages: inputMessages,
    };
    if (systemMsg) body.system = systemMsg;

    const r = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${errText.slice(0, 120)}`);
    }
    const data = await r.json();
    return {
      text: data.content?.map(c => c.text || '').join('') || '',
      duration: Date.now() - startTime,
    };
  }

  // OpenAI 兼容
  const messages = [];
  if (systemMsg) messages.push({ role: 'system', content: systemMsg });
  messages.push(...inputMessages);

  const body = { model: config.model, messages };
  const tokensField = config.tokensParam || 'max_tokens';
  body[tokensField] = maxTokens;
  const r = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${errText.slice(0, 120)}`);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  const finishReason = data.choices?.[0]?.finish_reason;
  const usage = data.usage || {};
  // 推理模型空回答：思考耗光了 token 配额
  if (!text.trim()) {
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    if (finishReason === 'length' || reasoningTokens) {
      throw new Error(`空回答：思考占用了 ${reasoningTokens || usage.completion_tokens || '?'} tokens，没留出输出预算（finish: ${finishReason}）。建议简化提问或在配置里调高 maxTokens`);
    }
    throw new Error(`空回答（finish: ${finishReason || '未知'}）`);
  }
  return {
    text,
    duration: Date.now() - startTime,
    tokens: data.usage?.total_tokens,
  };
}

// 加超时
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms)),
  ]);
}

// —————————————————————————————————————————————————————————
// 流式调用：调用单个模型，边收边通过 onChunk 推送文本增量
// 解析 OpenAI 兼容 SSE 协议（所有模型现在都走 openai provider）
// 返回 { text, duration, tokens? } 在流结束后 resolve
// —————————————————————————————————————————————————————————
export async function callModelStream(config, promptOrMessages, systemPrompt, env, onChunk, options = {}) {
  const startTime = Date.now();
  const apiKey = env[config.keyEnv];
  if (!apiKey) throw new Error(`服务端未配置 ${config.name} 的 Key`);

  const systemMsg = buildSystemMessage(systemPrompt);
  const maxTokens = options.maxTokens || config.maxTokens || 2500;
  const inputMessages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: 'user', content: promptOrMessages }];

  // 拼请求体
  const messages = [];
  if (systemMsg) messages.push({ role: 'system', content: systemMsg });
  messages.push(...inputMessages);

  const body = { model: config.model, messages, stream: true, stream_options: { include_usage: true } };
  const tokensField = config.tokensParam || 'max_tokens';
  body[tokensField] = maxTokens;

  const r = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${errText.slice(0, 120)}`);
  }
  if (!r.body) throw new Error('流式响应无 body');

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullText = '';
  let totalTokens = 0;
  let finishReason = null;
  let reasoningTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 块用 \n\n 分隔
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // 一个块里可能有多行，每行 "data: ..."；我们只关心 data 行
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          let event;
          try { event = JSON.parse(payload); } catch (e) { continue; }
          const choice = event.choices?.[0];
          if (choice) {
            const delta = choice.delta?.content;
            if (typeof delta === 'string' && delta) {
              fullText += delta;
              try { onChunk?.(delta); } catch (e) {}
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
          if (event.usage) {
            totalTokens = event.usage.total_tokens || totalTokens;
            reasoningTokens = event.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }

  // 空回答检测（推理模型可能思考耗光预算）
  if (!fullText.trim()) {
    if (finishReason === 'length' || reasoningTokens) {
      throw new Error(`空回答：思考占用了 ${reasoningTokens || '?'} tokens，没留出输出预算（finish: ${finishReason}）`);
    }
    throw new Error(`空回答（finish: ${finishReason || '未知'}）`);
  }

  return {
    text: fullText,
    duration: Date.now() - startTime,
    tokens: totalTokens || undefined,
  };
}
