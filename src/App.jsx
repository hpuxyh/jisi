import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Send, Settings, Copy, Check, AlertCircle, Loader2,
  X, Sparkles, MessageSquare, Plus, Trash2, Menu,
  Clock, Hash, User, BookOpen, ListChecks, GitCompare,
  CalendarClock, Zap, ChevronDown, ChevronUp, ChevronRight, ArrowUp,
  Download, RefreshCw,
} from 'lucide-react';
import { fetchModels, fetchQuota, ask } from './api.js';

const STORAGE_KEY = 'jisi_saas_v2';
const LEGACY_KEY = 'jisi_saas_prefs_v1';
const DEFAULT_SYSTEM_PROMPT = { role: '', context: '', instructions: '' };
const SUMMARY_TAB_ID = '__summary__';
const MAX_TURNS = 10;
const DEFAULT_DIMENSIONS = [
  { title: '核心共识', hint: '所有模型一致的关键观点（如果没有就写"无明显共识"）' },
  { title: '主要分歧', hint: '观点上的明显差异，标注是哪些模型的立场' },
  { title: '角度与深度差异', hint: '谁更聚焦哪个维度、谁更深入' },
  { title: '风格差异', hint: '表达方式上的特征对比' },
];

const DIMENSION_PRESETS = [
  { name: '客观分析', dims: DEFAULT_DIMENSIONS },
  { name: '产品决策', dims: [
    { title: '实操难度', hint: '对一个普通运营/PM 来说上手成本如何' },
    { title: 'ROI 周期', hint: '1 个月 / 3 个月 / 半年三个时间点能看到什么效果' },
    { title: '主要风险', hint: '可能掉坑的地方、需要避开的陷阱' },
    { title: '适用场景', hint: '什么样的产品/团队最适合采用，什么情况下不该用' },
  ] },
  { name: '写作风格', dims: [
    { title: '结构', hint: '段落组织、逻辑骨架的差异' },
    { title: '语气', hint: '正式 / 口语化 / 学术 / 营销等基调' },
    { title: '受众', hint: '内容默认面向的读者画像不同点' },
    { title: '信息密度', hint: '观点 vs. 例证 vs. 数据的比例' },
  ] },
  { name: '技术深度', dims: [
    { title: '概念清晰度', hint: '术语解释和概念边界是否准确' },
    { title: '实践细节', hint: '代码、配置、参数级别的具体建议' },
    { title: '适用场景', hint: '什么情况下用、什么情况下不用' },
    { title: '局限与坑', hint: '已知不足、社区反馈的常见问题' },
  ] },
  { name: '批判分析', dims: [
    { title: '论点', hint: '核心主张是什么' },
    { title: '论据', hint: '用来支撑的事实和例子' },
    { title: '隐含假设', hint: '没有明说但默认成立的前提' },
    { title: '反例与缺陷', hint: '可能不成立的情况、逻辑漏洞' },
  ] },
];

function dimsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x.title === b[i].title && (x.hint || '') === (b[i].hint || ''));
}

// ============================================================
// 持久化 & 数据模型
// ============================================================
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const p = JSON.parse(legacy);
      return { prefs: { systemPrompt: p.systemPrompt || DEFAULT_SYSTEM_PROMPT, summaryModelId: p.summaryModelId, enabledIds: p.enabledIds }, conversations: [], activeConversationId: null };
    }
    return null;
  } catch (e) { return null; }
}

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

function randomId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }

function makeConversation() {
  return { id: randomId('conv'), title: '新对话', createdAt: Date.now(), turns: [] };
}

function deriveTitle(q) {
  if (!q) return '新对话';
  const t = q.trim().replace(/\s+/g, ' ');
  return t.length > 24 ? t.slice(0, 24) + '…' : t;
}

// 从一轮已完成的 turn 中提取「模型回答」给后续轮做上下文
function turnToHistoryItem(turn) {
  const responses = {};
  Object.entries(turn.responses || {}).forEach(([mid, r]) => {
    if (r?.status === 'done' && r.text) responses[mid] = r.text;
  });
  return { question: turn.question, responses };
}

// 一轮 → markdown
function turnToMarkdown(turn, models) {
  const lines = [`## 问题：${turn.question}`, ''];
  for (const m of models) {
    const r = turn.responses?.[m.id];
    if (!r) continue;
    lines.push(`### ${m.name} (\`${m.model}\`)`);
    if (r.status === 'done') {
      const meta = [`${(r.duration / 1000).toFixed(2)}s`, r.tokens ? `${r.tokens} tokens` : null].filter(Boolean).join(' · ');
      if (meta) lines.push(`*${meta}*`, '');
      lines.push(r.text || '');
    } else if (r.status === 'error') {
      lines.push(`> ❌ ${r.error || '失败'}`);
    } else if (r.status === 'loading') {
      lines.push('> ⏳ 仍在生成中');
    }
    lines.push('');
  }
  if (turn.summary?.status === 'done' && turn.summary.text) {
    lines.push(`### 对比分析 (by ${turn.summary.modelName || ''})`, '', turn.summary.text, '');
  }
  return lines.join('\n');
}

// 整个对话 → markdown
function conversationToMarkdown(conv, models) {
  const head = [`# ${conv.title || '对话'}`, '', `> 创建于 ${new Date(conv.createdAt).toLocaleString()}`, `> 共 ${conv.turns?.length || 0} 轮`, '', '---', ''];
  const body = (conv.turns || []).map(t => turnToMarkdown(t, models)).join('\n---\n\n');
  return head.join('\n') + body;
}

// ============================================================
// 主组件
// ============================================================
export default function App() {
  const [models, setModels] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [summaryModelId, setSummaryModelId] = useState('deepseek');
  const [enabledIds, setEnabledIds] = useState(null);
  const [dimensions, setDimensions] = useState(DEFAULT_DIMENSIONS);

  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);

  const [quota, setQuota] = useState(null);
  const [activeTabId, setActiveTabId] = useState(SUMMARY_TAB_ID);
  const [question, setQuestion] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false); // 移动端抽屉
  const [loading, setLoading] = useState(false);
  const [askError, setAskError] = useState(null);
  const [collapsedTurnIds, setCollapsedTurnIds] = useState(() => new Set());
  const [showScrollTop, setShowScrollTop] = useState(false);
  const mainScrollRef = useRef(null);

  // 初始化
  useEffect(() => {
    (async () => {
      const [mResult, qResult] = await Promise.allSettled([fetchModels(), fetchQuota()]);
      const loadedModels = mResult.status === 'fulfilled' ? (mResult.value.models || []) : [];
      const availableIds = loadedModels.map(m => m.id);
      setModels(loadedModels);
      if (qResult.status === 'fulfilled') setQuota(qResult.value);

      const state = loadState();
      if (state?.prefs) {
        if (state.prefs.systemPrompt) setSystemPrompt({ ...DEFAULT_SYSTEM_PROMPT, ...state.prefs.systemPrompt });
        if (state.prefs.summaryModelId && availableIds.includes(state.prefs.summaryModelId)) {
          setSummaryModelId(state.prefs.summaryModelId);
        } else if (availableIds.length > 0) {
          setSummaryModelId(availableIds[0]);
        }
        if (Array.isArray(state.prefs.enabledIds)) {
          const filtered = state.prefs.enabledIds.filter(id => availableIds.includes(id));
          setEnabledIds(filtered);
        }
        if (Array.isArray(state.prefs.dimensions) && state.prefs.dimensions.length > 0) {
          setDimensions(state.prefs.dimensions);
        }
      } else if (availableIds.length > 0) {
        setSummaryModelId(availableIds[0]);
      }
      if (state?.conversations?.length) {
        setConversations(state.conversations);
        if (state.activeConversationId && state.conversations.find(c => c.id === state.activeConversationId)) {
          setActiveConversationId(state.activeConversationId);
        } else {
          setActiveConversationId(state.conversations[0].id);
        }
      }
      setModelsLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (modelsLoaded && enabledIds === null && models.length > 0) setEnabledIds(models.map(m => m.id));
  }, [modelsLoaded, enabledIds, models]);

  useEffect(() => {
    if (!modelsLoaded) return;
    saveState({ prefs: { systemPrompt, summaryModelId, enabledIds, dimensions }, conversations, activeConversationId });
  }, [systemPrompt, summaryModelId, enabledIds, dimensions, conversations, activeConversationId, modelsLoaded]);

  const enabledModels = useMemo(
    () => enabledIds ? models.filter(m => enabledIds.includes(m.id)) : [],
    [enabledIds, models],
  );
  const showSummaryTab = enabledModels.length >= 2;
  const activeModel = activeTabId === SUMMARY_TAB_ID ? null : enabledModels.find(m => m.id === activeTabId);
  const summaryModelMeta = models.find(m => m.id === summaryModelId);
  const hasSystemPrompt = !!(systemPrompt.role || systemPrompt.context || systemPrompt.instructions);

  const activeConversation = conversations.find(c => c.id === activeConversationId) || null;
  const turns = activeConversation?.turns || [];
  const turnsUsed = turns.length;
  const reachedLimit = turnsUsed >= MAX_TURNS;

  useEffect(() => {
    if (!showSummaryTab && activeTabId === SUMMARY_TAB_ID && enabledModels[0]) {
      setActiveTabId(enabledModels[0].id);
    }
  }, [showSummaryTab, activeTabId, enabledModels]);

  // 滚动锚点：每次 turns 变化或 loading 变化时滚到底
  const turnsBottomRef = useRef(null);
  useEffect(() => { turnsBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, loading, activeTabId]);

  // 切换对话时：除最后一轮外其它默认折叠
  useEffect(() => {
    if (!activeConversation) { setCollapsedTurnIds(new Set()); return; }
    const ts = activeConversation.turns || [];
    if (ts.length <= 1) setCollapsedTurnIds(new Set());
    else setCollapsedTurnIds(new Set(ts.slice(0, -1).map(t => t.id)));
    // 切对话也回到顶部
    requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ top: 0 }));
  }, [activeConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 主内容滚动监听：决定回顶部按钮是否显示
  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    const onScroll = () => setShowScrollTop(el.scrollTop > 200);
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const updateTurn = useCallback((convId, turnId, patch) => {
    setConversations(prev => prev.map(c => {
      if (c.id !== convId) return c;
      return { ...c, turns: c.turns.map(t => t.id === turnId ? { ...t, ...patch } : t) };
    }));
  }, []);

  const toggleTurnCollapsed = useCallback((turnId) => {
    setCollapsedTurnIds(prev => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  const scrollToTop = useCallback(() => {
    mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const copyTurn = useCallback(async (turn) => {
    const md = turnToMarkdown(turn, models);
    try { await navigator.clipboard.writeText(md); return true; } catch (e) { return false; }
  }, [models]);

  const retryModel = useCallback(async (turnId, modelId) => {
    const conv = conversations.find(c => c.id === activeConversationId);
    if (!conv) return;
    const turnIndex = conv.turns.findIndex(t => t.id === turnId);
    if (turnIndex < 0) return;
    const turn = conv.turns[turnIndex];
    const m = models.find(x => x.id === modelId);
    if (!m) return;

    // 把这一轮里目标模型设置回 loading
    updateTurn(activeConversationId, turnId, {
      responses: { ...turn.responses, [modelId]: { status: 'loading' } },
    });

    // history = 截至本轮之前的所有轮（不含本轮）
    const history = conv.turns.slice(0, turnIndex).map(turnToHistoryItem);

    try {
      const data = await ask({
        question: turn.question,
        systemPrompt: hasSystemPrompt ? systemPrompt : null,
        modelIds: [modelId],
        summaryModelId: undefined,
        history,
      });
      const r = (data.results || [])[0];
      const next = r?.ok
        ? { status: 'done', text: r.text, duration: r.duration, tokens: r.tokens }
        : { status: 'error', error: r?.error || '失败' };
      // 重新读最新 conv（因为可能有别的 turn 也在 loading）
      setConversations(prev => prev.map(c => {
        if (c.id !== activeConversationId) return c;
        return { ...c, turns: c.turns.map(t => t.id !== turnId ? t : { ...t, responses: { ...t.responses, [modelId]: next } }) };
      }));
      if (data.quota) setQuota(prev => ({ ...prev, ...data.quota }));
    } catch (e) {
      updateTurn(activeConversationId, turnId, {
        responses: { ...turn.responses, [modelId]: { status: 'error', error: e.message || '失败' } },
      });
    }
  }, [conversations, activeConversationId, models, hasSystemPrompt, systemPrompt, updateTurn]);

  const exportConversation = useCallback(async () => {
    if (!activeConversation) return;
    const md = conversationToMarkdown(activeConversation, models);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${activeConversation.title || 'conversation'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }, [activeConversation, models]);

  // —— 操作 ——
  const newConversation = useCallback(() => {
    const conv = makeConversation();
    setConversations(prev => [conv, ...prev]);
    setActiveConversationId(conv.id);
    setActiveTabId(showSummaryTab ? SUMMARY_TAB_ID : (enabledModels[0]?.id || SUMMARY_TAB_ID));
    setQuestion('');
    setAskError(null);
    setShowSidebar(false);
  }, [showSummaryTab, enabledModels]);

  const selectConversation = useCallback((id) => {
    setActiveConversationId(id);
    setQuestion('');
    setAskError(null);
    setShowSidebar(false);
  }, []);

  const deleteConversation = useCallback((id) => {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id);
      if (id === activeConversationId) {
        setActiveConversationId(next[0]?.id || null);
      }
      return next;
    });
  }, [activeConversationId]);

  const handleAsk = useCallback(async () => {
    const q = question.trim();
    if (!q || loading) return;
    if (!enabledModels.length) return;
    if (quota && quota.remaining <= 0) return;

    // 确定使用哪个对话：没有任何对话时新建一个
    let convId = activeConversationId;
    let conv = conversations.find(c => c.id === convId);
    if (!conv) {
      const newConv = makeConversation();
      conv = newConv;
      convId = newConv.id;
      setConversations(prev => [newConv, ...prev]);
      setActiveConversationId(newConv.id);
    }

    if ((conv.turns?.length || 0) >= MAX_TURNS) {
      setAskError({ type: 'limit', message: `本对话已达 ${MAX_TURNS} 轮上限，请新建对话继续` });
      return;
    }

    setAskError(null);
    setLoading(true);

    // 创建新 turn（loading 态）
    const turnId = randomId('turn');
    const initialResponses = {};
    enabledModels.forEach(m => { initialResponses[m.id] = { status: 'loading' }; });
    const newTurn = {
      id: turnId,
      question: q,
      modelIds: enabledModels.map(m => m.id),
      summaryModelId,
      responses: initialResponses,
      summary: showSummaryTab ? { status: 'loading' } : null,
      createdAt: Date.now(),
    };

    // 把当前对话里所有旧 turn 折叠起来，新 turn 默认展开
    setCollapsedTurnIds(prev => {
      const next = new Set(prev);
      (conv.turns || []).forEach(t => next.add(t.id));
      return next;
    });

    setConversations(prev => prev.map(c => {
      if (c.id !== convId) return c;
      const title = c.turns.length === 0 ? deriveTitle(q) : c.title;
      return { ...c, title, turns: [...c.turns, newTurn] };
    }));
    setQuestion('');

    // 准备 history（不含当前轮）
    const history = (conv.turns || []).map(turnToHistoryItem);

    try {
      const data = await ask({
        question: q,
        systemPrompt: hasSystemPrompt ? systemPrompt : null,
        modelIds: enabledModels.map(m => m.id),
        summaryModelId,
        history,
        dimensions: showSummaryTab ? dimensions : undefined,
      });

      const nextResponses = {};
      (data.results || []).forEach(r => {
        nextResponses[r.id] = r.ok
          ? { status: 'done', text: r.text, duration: r.duration, tokens: r.tokens }
          : { status: 'error', error: r.error };
      });

      let nextSummary = null;
      if (data.summary) {
        if (data.summary.ok) {
          nextSummary = { status: 'done', text: data.summary.text, duration: data.summary.duration, modelName: data.summary.modelName };
        } else if (data.summary.insufficient) {
          nextSummary = { status: 'insufficient', successful: data.summary.successful };
        } else {
          nextSummary = { status: 'error', error: data.summary.error, modelName: data.summary.modelName };
        }
      }

      updateTurn(convId, turnId, { responses: nextResponses, summary: nextSummary });
      if (data.quota) setQuota(prev => ({ ...prev, ...data.quota }));
    } catch (e) {
      if (e.quotaExceeded) {
        setQuota({ used: e.data?.used ?? quota?.limit, limit: e.data?.limit ?? quota?.limit, remaining: 0 });
        setAskError({ type: 'quota', message: e.message });
      } else if (e.maxTurnsReached) {
        setAskError({ type: 'limit', message: e.message });
      } else {
        setAskError({ type: 'network', message: e.message || '请求失败' });
      }
      // 标记所有 loading 为 error
      const errResponses = {};
      enabledModels.forEach(m => { errResponses[m.id] = { status: 'error', error: e.message || '请求失败' }; });
      updateTurn(convId, turnId, { responses: errResponses, summary: showSummaryTab ? { status: 'error', error: e.message } : null });
    } finally {
      setLoading(false);
    }
  }, [question, loading, enabledModels, quota, systemPrompt, hasSystemPrompt, summaryModelId, showSummaryTab, activeConversationId, conversations, updateTurn, dimensions]);

  if (!modelsLoaded) return <FullPageLoader />;

  return (
    <div className="min-h-screen flex" style={{ background: '#F0EEE6' }}>
      {/* Sidebar：>= md 永久显示；< md 抽屉 */}
      <ConversationSidebar
        conversations={conversations}
        activeId={activeConversationId}
        onSelect={selectConversation}
        onNew={newConversation}
        onDelete={deleteConversation}
        visibleOnMobile={showSidebar}
        onCloseMobile={() => setShowSidebar(false)}
      />

      <div className="flex-1 flex justify-center">
        <div
          className="w-full max-w-[760px] flex flex-col"
          style={{ background: '#FAF9F5', borderLeft: '1px solid var(--border-hair)', borderRight: '1px solid var(--border-hair)', minHeight: '100vh' }}
        >
          <Header
            title={activeConversation?.title}
            quota={quota}
            onOpenSettings={() => setShowSettings(true)}
            onToggleSidebar={() => setShowSidebar(v => !v)}
            hasTurns={turns.length > 0}
            onExport={exportConversation}
          />

          {askError && (
            <div className="px-5 py-3" style={{ background: '#FDEDE8', borderBottom: '1px solid #F5D5CC' }}>
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
                <div className="text-xs leading-relaxed flex-1" style={{ color: '#b91c1c' }}>{askError.message}</div>
                {askError.type === 'limit' && (
                  <button onClick={newConversation} className="text-xs px-2 py-1 rounded shrink-0" style={{ color: '#b91c1c', border: '1px solid #f0c4c0', background: '#fff' }}>
                    新建对话
                  </button>
                )}
                <button onClick={() => setAskError(null)} style={{ color: '#dc2626' }}><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          )}

          {quota && quota.remaining <= 0 && !askError && <QuotaExhaustedBanner quota={quota} />}

          {enabledModels.length > 0 && (
            <div className="relative" style={{ borderBottom: '1px solid var(--border-hair)' }}>
              <ModelTabs
                models={enabledModels}
                activeId={activeTabId}
                onSelect={setActiveTabId}
                turns={turns}
                showSummaryTab={showSummaryTab}
                loading={loading}
              />
              {loading && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden">
                  <div className="h-full w-1/3 indeterminate" style={{ background: 'linear-gradient(90deg, transparent, #CC785C, transparent)' }} />
                </div>
              )}
            </div>
          )}

          {/* 主内容：轮次列表 */}
          <div className="flex-1 relative min-h-0">
            <div ref={mainScrollRef} className="absolute inset-0 overflow-y-auto custom-scroll">
              {turns.length === 0 ? (
                activeTabId === SUMMARY_TAB_ID && showSummaryTab
                  ? <SummaryIdle models={enabledModels} summaryModelMeta={summaryModelMeta} dimensions={dimensions} onOpenSettings={() => setShowSettings(true)} />
                  : activeModel
                    ? <IdleHint modelName={activeModel.name} />
                    : <EmptyState />
              ) : (
                <TurnsList
                  turns={turns}
                  activeTabId={activeTabId}
                  activeModel={activeModel}
                  enabledModels={enabledModels}
                  summaryModelMeta={summaryModelMeta}
                  onSelectTab={setActiveTabId}
                  collapsedTurnIds={collapsedTurnIds}
                  onToggleCollapse={toggleTurnCollapsed}
                  onCopyTurn={copyTurn}
                  onRetryModel={retryModel}
                />
              )}
              <div ref={turnsBottomRef} />
            </div>
            {showScrollTop && (
              <button
                onClick={scrollToTop}
                title="回到顶部"
                aria-label="回到顶部"
                className="absolute bottom-5 right-5 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 fade-up"
                style={{ background: '#FFFFFF', boxShadow: 'var(--shadow-float)', color: '#CC785C' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#F5EBDD'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
              >
                <ArrowUp className="w-4 h-4" strokeWidth={2.5} />
              </button>
            )}
          </div>

          {/* 底部输入框 */}
          <div className="shrink-0 px-4 pt-3 pb-4" style={{ background: '#FAF9F5' }}>
            <QuestionInput
              value={question}
              onChange={setQuestion}
              onSubmit={handleAsk}
              onNewConversation={newConversation}
              modelCount={enabledModels.length}
              hasSystemPrompt={hasSystemPrompt}
              onOpenSettings={() => setShowSettings(true)}
              loading={loading}
              quotaExhausted={quota && quota.remaining <= 0}
              turnsUsed={turnsUsed}
              reachedLimit={reachedLimit}
            />
          </div>

          <Footer />
        </div>
      </div>

      <SettingsDrawer
        open={showSettings}
        models={models}
        systemPrompt={systemPrompt}
        summaryModelId={summaryModelId}
        enabledIds={enabledIds || []}
        dimensions={dimensions}
        onChangeSystemPrompt={setSystemPrompt}
        onChangeSummaryModelId={setSummaryModelId}
        onChangeEnabledIds={setEnabledIds}
        onChangeDimensions={setDimensions}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}

// ============================================================
// Loader
// ============================================================
function FullPageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#F0EEE6' }}>
      <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#CC785C' }} />
    </div>
  );
}

// ============================================================
// Sidebar
// ============================================================
function ConversationSidebar({ conversations, activeId, onSelect, onNew, onDelete, visibleOnMobile, onCloseMobile }) {
  return (
    <>
      {visibleOnMobile && <div className="md:hidden fixed inset-0 z-30" style={{ background: 'rgba(40,32,24,0.4)' }} onClick={onCloseMobile} />}
      <aside
        className={`shrink-0 flex flex-col fixed md:static inset-y-0 left-0 z-40 transform transition-transform md:translate-x-0 ${visibleOnMobile ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ width: 260, background: '#F0EEE6', borderRight: '1px solid var(--border-hair)' }}
      >
        <div className="px-5 py-5 flex items-center gap-2.5" >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: '#CC785C' }}>
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="brand text-[18px]" style={{ color: '#1A1815' }}>集思</span>
          <button onClick={onCloseMobile} className="md:hidden ml-auto" style={{ color: '#9D9685' }}><X className="w-4 h-4" /></button>
        </div>

        <div className="px-3 pb-3">
          <button
            onClick={onNew}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[13px] font-medium transition-all hover:shadow-md"
            style={{ background: '#FFFFFF', color: '#2A2620', border: '1px solid var(--border-soft)' }}
          >
            <Plus className="w-3.5 h-3.5" style={{ color: '#CC785C' }} /> 新对话
          </button>
        </div>

        <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: '#BFB8A8' }}>
          最近
        </div>

        <div className="flex-1 overflow-y-auto custom-scroll px-2 pb-3 space-y-0.5">
          {conversations.length === 0 && (
            <div className="text-center py-8 text-xs" style={{ color: '#9D9685' }}>暂无对话</div>
          )}
          {conversations.map(c => {
            const active = c.id === activeId;
            return (
              <div
                key={c.id}
                className="group relative rounded-lg transition-colors"
                style={{ background: active ? 'rgba(204,120,92,0.08)' : 'transparent' }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(60,50,40,0.04)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <button onClick={() => onSelect(c.id)} className="w-full text-left px-3 py-2.5 pr-8">
                  <div className="text-[13px] font-medium truncate" style={{ color: active ? '#1A1815' : '#3D3829' }}>{c.title}</div>
                  <div className="flex items-center gap-2 mt-0.5 font-mono text-[10px]" style={{ color: '#9D9685' }}>
                    <span>{c.turns?.length || 0}/{MAX_TURNS} 轮</span>
                    <span>·</span>
                    <span>{formatTime(c.createdAt)}</span>
                  </div>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); if (window.confirm('删除这个对话？')) onDelete(c.id); }}
                  className="absolute top-1/2 -translate-y-1/2 right-1.5 w-6 h-6 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: '#9D9685' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#FDEDE8'; e.currentTarget.style.color = '#dc2626'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9D9685'; }}
                  title="删除"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="px-5 py-3 font-mono text-[10px]" style={{ color: '#9D9685', borderTop: '1px solid var(--border-hair)' }}>
          单对话最多 {MAX_TURNS} 轮
        </div>
      </aside>
    </>
  );
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ============================================================
// Header
// ============================================================
function Header({ title, quota, onOpenSettings, onToggleSidebar, hasTurns, onExport }) {
  const isDefault = !title || title === '新对话';
  return (
    <header className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--border-hair)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <button onClick={onToggleSidebar} className="md:hidden w-8 h-8 -ml-1 rounded-md flex items-center justify-center" style={{ color: '#6F6E5E' }}>
          <Menu className="w-5 h-5" />
        </button>
        {isDefault ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="brand text-[19px]" style={{ color: '#1A1815' }}>集思</span>
            <span className="text-[11px]" style={{ color: '#9D9685', letterSpacing: '0.18em' }}>一问 · 多答 · 比对</span>
          </div>
        ) : (
          <div className="text-[14px] font-medium truncate" style={{ color: '#1A1815' }}>{title}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {hasTurns && (
          <button
            onClick={onExport}
            title="导出本对话为 Markdown"
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: '#6F6E5E' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F5F1E8'; e.currentTarget.style.color = '#CC785C'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#6F6E5E'; }}
          >
            <Download className="w-4 h-4" />
          </button>
        )}
        {quota && <QuotaBadge quota={quota} />}
        <button
          onClick={onOpenSettings}
          title="设置"
          className="xl:hidden w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
          style={{ color: '#6F6E5E' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#F5F1E8'; e.currentTarget.style.color = '#2A2620'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#6F6E5E'; }}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

function QuotaBadge({ quota }) {
  const ratio = quota.remaining / quota.limit;
  const danger = ratio < 0.1;
  const warn = ratio < 0.3;
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px]"
      style={{ background: danger ? '#FDEDE8' : warn ? '#F5EBDD' : '#FFFFFF', border: `1px solid ${danger ? '#F5D5CC' : warn ? '#E5C5A0' : 'var(--border-soft)'}`, color: danger ? '#b91c1c' : warn ? '#CC785C' : '#6F6E5E' }}
      title={`今日已用 ${quota.used}/${quota.limit}，${quota.resetAt || '次日 0 点'}重置`}
    >
      <Zap className="w-3 h-3" />
      <span>{quota.remaining}<span style={{ opacity: 0.5 }}> / {quota.limit}</span></span>
    </div>
  );
}

// ============================================================
// 输入框
// ============================================================
function QuestionInput({ value, onChange, onSubmit, onNewConversation, modelCount, hasSystemPrompt, onOpenSettings, loading, quotaExhausted, turnsUsed, reachedLimit }) {
  const [focused, setFocused] = useState(false);
  const disabled = loading || quotaExhausted || modelCount === 0 || reachedLimit;
  const handleKey = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); } };

  if (reachedLimit) {
    return (
      <div className="rounded-lg p-3.5 flex items-center justify-between gap-3" style={{ background: '#F5F1E8', border: '1px solid #E5C5A0' }}>
        <div className="text-xs leading-relaxed" style={{ color: '#6F6E5E' }}>
          已达 {MAX_TURNS} 轮上限。新建对话继续？
        </div>
        <button onClick={onNewConversation} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium shrink-0" style={{ background: 'linear-gradient(135deg, #E5A57F, #CC785C)', color: '#ffffff' }}>
          <Plus className="w-3 h-3" /> 新对话
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <label className="font-mono text-[10px] tracking-[0.15em] uppercase" style={{ color: '#9D9685' }}>提问</label>
          {hasSystemPrompt && (
            <button onClick={onOpenSettings} className="flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ color: '#CC785C', border: '1px solid #E5C5A0', background: '#F5EBDD' }}>
              <User className="w-2.5 h-2.5" /> 已设定
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px]" style={{ color: '#9D9685' }}>
          <span>已问 <span style={{ color: turnsUsed >= MAX_TURNS - 2 ? '#CC785C' : '#6F6E5E', fontWeight: 600 }}>{turnsUsed}</span>/{MAX_TURNS}</span>
          <span style={{ color: '#BFB8A8' }}>⌘ + ↵</span>
        </div>
      </div>
      <div
        className="relative rounded-2xl transition-all"
        style={{
          background: '#FFFFFF',
          border: `1px solid ${focused ? '#CC785C' : '#E8E2D2'}`,
          boxShadow: focused ? 'var(--shadow-input-focus)' : 'var(--shadow-input)',
        }}
      >
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={quotaExhausted ? '今日配额已用完...' : (turnsUsed === 0 ? '问一个问题，让所有模型同时回答...' : '继续追问...')}
          rows={2}
          disabled={quotaExhausted}
          className="w-full bg-transparent text-[15px] leading-relaxed px-4 pt-3.5 pb-2 resize-none focus:outline-none disabled:cursor-not-allowed placeholder:text-[#BFB8A8]"
          style={{ color: '#2A2620' }}
        />
        <div className="flex items-center justify-between px-4 pb-3 pt-1">
          <span className="font-mono text-[10px]" style={{ color: '#9D9685' }}>
            将广播至 <span style={{ color: '#CC785C', fontWeight: 600 }}>{modelCount}</span> 个模型
          </span>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || disabled}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: value.trim() && !disabled ? '#CC785C' : '#E8E2D2', color: value.trim() && !disabled ? '#ffffff' : '#9D9685' }}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <>发送 <Send className="w-3 h-3" /></>}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuotaExhaustedBanner({ quota }) {
  return (
    <div className="fade-up px-5 py-4" style={{ background: '#F5F1E8', borderBottom: '1px solid #EFE9DB' }}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: '#F5EBDD' }}>
          <CalendarClock className="w-4 h-4" style={{ color: '#CC785C' }} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium mb-1" style={{ color: '#2A2620' }}>今日 {quota.limit} 次配额已用完</div>
          <div className="text-xs leading-relaxed" style={{ color: '#6F6E5E' }}>{quota.resetAt || '北京时间 00:00'} 重置，明天再来吧 👋</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Tab 栏：基于最新轮次状态显示模型的成功 / 失败 / 加载图标
// ============================================================
function ModelTabs({ models, activeId, onSelect, turns, showSummaryTab, loading }) {
  const lastTurn = turns[turns.length - 1];
  return (
    <div className="flex overflow-x-auto scrollbar-hide gap-1 px-3 py-2">
      {showSummaryTab && (
        <SummaryTab
          active={activeId === SUMMARY_TAB_ID}
          onClick={() => onSelect(SUMMARY_TAB_ID)}
          models={models}
          summary={lastTurn?.summary}
          loading={loading}
        />
      )}
      {models.map((m) => {
        const state = lastTurn?.responses?.[m.id];
        const active = m.id === activeId;
        return (
          <button
            key={m.id}
            onClick={() => onSelect(m.id)}
            className="relative shrink-0 px-3.5 py-1.5 rounded-full transition-all flex items-center gap-1.5"
            style={{
              background: active ? '#FFFFFF' : 'transparent',
              border: `1px solid ${active ? 'var(--border-soft)' : 'transparent'}`,
              boxShadow: active ? 'var(--shadow-card)' : 'none',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(60,50,40,0.04)'; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >
            <ModelStatusIndicator state={state} color={m.color} />
            <span className="text-[12px] font-medium tracking-wide whitespace-nowrap" style={{ color: active ? '#1A1815' : '#6F6E5E' }}>{m.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function SummaryTab({ active, onClick, models, summary, loading }) {
  const showCheck = summary?.status === 'done';
  const showError = summary?.status === 'error' || summary?.status === 'insufficient';
  return (
    <button
      onClick={onClick}
      className="relative shrink-0 px-3.5 py-1.5 rounded-full transition-all flex items-center gap-1.5"
      style={{
        background: active ? '#FFFFFF' : 'transparent',
        border: `1px solid ${active ? '#E5C5A0' : 'transparent'}`,
        boxShadow: active ? 'var(--shadow-card)' : 'none',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(204,120,92,0.06)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <div className="flex items-center">
        {models.slice(0, 5).map((m, i) => (
          <div key={m.id} className="w-2 h-2 rounded-full" style={{ background: m.color, marginLeft: i > 0 ? '-4px' : 0, border: `1.5px solid ${active ? '#FFFFFF' : '#FAF9F5'}`, zIndex: 5 - i }} />
        ))}
      </div>
      <span className="text-[12px] font-semibold tracking-wide whitespace-nowrap" style={{ color: active ? '#CC785C' : '#3D3829' }}>对比</span>
      {loading && summary?.status === 'loading' && (
        <Loader2 className="w-3 h-3 animate-spin" style={{ color: '#CC785C' }} />
      )}
      {!loading && showCheck && (
        <div className="w-3 h-3 rounded-full flex items-center justify-center" style={{ background: '#059669' }}>
          <Check className="w-1.5 h-1.5 text-white" strokeWidth={3} />
        </div>
      )}
      {!loading && showError && (
        <div className="w-3 h-3 rounded-full flex items-center justify-center" style={{ background: '#dc2626' }}>
          <X className="w-1.5 h-1.5 text-white" strokeWidth={3} />
        </div>
      )}
    </button>
  );
}

function ModelStatusIndicator({ state, color }) {
  if (!state) return <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#BFB8A8' }} />;
  if (state.status === 'loading') return <div className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: color }} />;
  if (state.status === 'error') return <div className="w-2.5 h-2.5 rounded-full flex items-center justify-center" style={{ background: '#dc2626' }}><X className="w-1.5 h-1.5 text-white" strokeWidth={3} /></div>;
  if (state.status === 'done') return <div className="w-2.5 h-2.5 rounded-full flex items-center justify-center" style={{ background: color }}><Check className="w-1.5 h-1.5 text-white" strokeWidth={3} /></div>;
  return <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#BFB8A8' }} />;
}

// ============================================================
// 轮次列表（按 tab 切换显示当前模型的所有 Q&A）
// ============================================================
function TurnsList({ turns, activeTabId, activeModel, enabledModels, summaryModelMeta, onSelectTab, collapsedTurnIds, onToggleCollapse, onCopyTurn, onRetryModel }) {
  return (
    <div className="px-5 py-6 space-y-6">
      {turns.map((t, idx) => (
        <TurnCard
          key={t.id}
          turn={t}
          index={idx}
          activeTabId={activeTabId}
          activeModel={activeModel}
          enabledModels={enabledModels}
          summaryModelMeta={summaryModelMeta}
          onSelectTab={onSelectTab}
          collapsed={collapsedTurnIds.has(t.id)}
          onToggleCollapse={() => onToggleCollapse(t.id)}
          onCopyTurn={() => onCopyTurn(t)}
          onRetryModel={(modelId) => onRetryModel(t.id, modelId)}
        />
      ))}
    </div>
  );
}

function TurnCard({ turn, index, activeTabId, activeModel, enabledModels, summaryModelMeta, onSelectTab, collapsed, onToggleCollapse, onCopyTurn, onRetryModel }) {
  const turnTokens = Object.values(turn.responses || {}).reduce((sum, r) => sum + (r?.tokens || 0), 0);
  const turnDuration = Math.max(...Object.values(turn.responses || {}).map(r => r?.duration || 0), 0);
  const successCount = Object.values(turn.responses || {}).filter(r => r?.status === 'done').length;
  const allDone = Object.values(turn.responses || {}).every(r => r?.status === 'done' || r?.status === 'error');
  return (
    <div className="fade-up">
      <QuestionBubble index={index} text={turn.question} onCopyTurn={onCopyTurn} />
      {allDone && (turnTokens > 0 || turnDuration > 0) && (
        <div className="flex items-center gap-3 mt-1.5 ml-7 font-mono text-[10px]" style={{ color: '#9D9685' }}>
          {successCount > 0 && <span>{successCount} 个成功</span>}
          {turnTokens > 0 && <span className="flex items-center gap-1"><Hash className="w-2.5 h-2.5" />{turnTokens.toLocaleString()} tokens</span>}
          {turnDuration > 0 && <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{(turnDuration / 1000).toFixed(1)}s</span>}
        </div>
      )}
      <div className="mt-3">
        {activeTabId === SUMMARY_TAB_ID ? (
          <SummaryBlock summary={turn.summary} summaryModelMeta={summaryModelMeta} onSelectTab={onSelectTab} collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
        ) : activeModel ? (
          <ResponseBlock
            model={activeModel}
            state={turn.responses?.[activeModel.id]}
            collapsed={collapsed}
            onToggleCollapse={onToggleCollapse}
            onRetry={() => onRetryModel?.(activeModel.id)}
          />
        ) : null}
      </div>
    </div>
  );
}

function QuestionBubble({ index, text, onCopyTurn }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!onCopyTurn) return;
    const ok = await onCopyTurn();
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return (
    <div className="group flex items-start gap-3">
      <div className="font-mono text-[10px] mt-1.5 px-1.5 py-0.5 rounded shrink-0" style={{ color: '#CC785C', background: '#F5EBDD' }}>Q{index + 1}</div>
      <div className="flex-1 min-w-0 text-[15px] leading-[1.7] whitespace-pre-wrap break-words" style={{ color: '#1A1815', fontWeight: 500 }}>{text}</div>
      {onCopyTurn && (
        <button
          onClick={handleCopy}
          title="复制本轮全部内容（问题+各模型回答+对比）"
          className="shrink-0 w-7 h-7 mt-0.5 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: copied ? '#059669' : '#9D9685' }}
          onMouseEnter={(e) => { if (!copied) e.currentTarget.style.background = '#F5F1E8'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  );
}

function ResponseBlock({ model, state, collapsed, onToggleCollapse, onRetry }) {
  const [copied, setCopied] = useState(false);
  const canCollapse = state?.status === 'done' && state.text;
  const handleCopy = async (e) => {
    e.stopPropagation();
    if (state?.text) {
      try { await navigator.clipboard.writeText(state.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {}
    }
  };
  const toggleCollapse = () => { if (canCollapse) onToggleCollapse?.(); };
  return (
    <div className="card card-hover overflow-hidden">
      <div
        onClick={toggleCollapse}
        className="flex items-center justify-between px-4 py-2.5 select-none"
        style={{ borderBottom: collapsed ? 'none' : '1px solid var(--border-hair)', cursor: canCollapse ? 'pointer' : 'default' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {canCollapse && (
            collapsed
              ? <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: '#9D9685' }} />
              : <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: '#9D9685' }} />
          )}
          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: model.color }} />
          <span className="font-mono text-[10px] shrink-0" style={{ color: '#6F6E5E' }}>{model.model}</span>
          {collapsed && state?.text && (
            <span className="text-[11px] truncate" style={{ color: '#9D9685' }}>· {state.text.replace(/\s+/g, ' ').slice(0, 60)}{state.text.length > 60 ? '…' : ''}</span>
          )}
        </div>
        {state?.status === 'done' && (
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 font-mono text-[10px]" style={{ color: '#9D9685' }}>
              <Clock className="w-2.5 h-2.5" />{(state.duration / 1000).toFixed(2)}s
            </div>
            {state.tokens && (
              <div className="flex items-center gap-1 font-mono text-[10px]" style={{ color: '#9D9685' }}>
                <Hash className="w-2.5 h-2.5" />{state.tokens}
              </div>
            )}
            <button onClick={handleCopy} title="复制" style={{ color: copied ? '#059669' : '#9D9685' }}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="px-5 py-4">
          {!state && <div className="text-xs" style={{ color: '#9D9685' }}>此模型未参与本轮</div>}
          {state?.status === 'loading' && <LoadingState color={model.color} />}
          {state?.status === 'error' && <ErrorState message={state.error} onRetry={onRetry} />}
          {state?.status === 'done' && <ResponseText text={state.text} />}
        </div>
      )}
    </div>
  );
}

function SummaryBlock({ summary, summaryModelMeta, onSelectTab, collapsed, onToggleCollapse }) {
  const [copied, setCopied] = useState(false);
  const canCollapse = summary?.status === 'done' && summary.text;
  const handleCopy = async (e) => {
    e.stopPropagation();
    if (summary?.text) {
      try { await navigator.clipboard.writeText(summary.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {}
    }
  };
  const toggleCollapse = () => { if (canCollapse) onToggleCollapse?.(); };
  if (!summary) {
    return (
      <div className="card px-4 py-3 text-xs" style={{ color: '#9D9685' }}>
        本轮未生成对比（启用了不足 2 个模型）
      </div>
    );
  }
  return (
    <div className="card card-hover overflow-hidden">
      <div
        onClick={toggleCollapse}
        className="flex items-center justify-between px-4 py-2.5 select-none"
        style={{ borderBottom: collapsed ? 'none' : '1px solid var(--border-hair)', cursor: canCollapse ? 'pointer' : 'default' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {canCollapse && (
            collapsed
              ? <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: '#9D9685' }} />
              : <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: '#9D9685' }} />
          )}
          <GitCompare className="w-3 h-3 shrink-0" style={{ color: '#CC785C' }} />
          <span className="font-mono text-[10px] shrink-0" style={{ color: '#6F6E5E' }}>对比分析</span>
          {(summary.modelName || summaryModelMeta?.name) && !collapsed && (
            <span className="font-mono text-[10px] shrink-0" style={{ color: '#9D9685' }}>by {summary.modelName || summaryModelMeta?.name}</span>
          )}
          {collapsed && summary.text && (
            <span className="text-[11px] truncate" style={{ color: '#9D9685' }}>· {summary.text.replace(/\s+/g, ' ').slice(0, 60)}{summary.text.length > 60 ? '…' : ''}</span>
          )}
        </div>
        {summary.status === 'done' && (
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 font-mono text-[10px]" style={{ color: '#9D9685' }}>
              <Clock className="w-2.5 h-2.5" />{(summary.duration / 1000).toFixed(2)}s
            </div>
            <button onClick={handleCopy} title="复制" style={{ color: copied ? '#059669' : '#9D9685' }}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="px-5 py-4">
          {summary.status === 'loading' && <SummaryGenerating modelName={summaryModelMeta?.name} compact />}
          {summary.status === 'insufficient' && (
            <div className="text-xs" style={{ color: '#6F6E5E' }}>
              只有 {summary.successful?.length || 0} 个模型成功返回，无法对比。
              {summary.successful?.length === 1 && (
                <button onClick={() => onSelectTab(summary.successful[0].id)} className="ml-2 underline" style={{ color: '#CC785C' }}>
                  查看 {summary.successful[0].name} 的回答
                </button>
              )}
            </div>
          )}
          {summary.status === 'error' && <ErrorState message={summary.error} />}
          {summary.status === 'done' && <ResponseText text={summary.text} />}
        </div>
      )}
    </div>
  );
}

function SummaryIdle({ models, summaryModelMeta, dimensions, onOpenSettings }) {
  return (
    <div className="flex flex-col items-center text-center px-8 py-12">
      <div className="relative mb-6">
        <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: '#F5EBDD' }}>
          <GitCompare className="w-5 h-5" style={{ color: '#CC785C' }} />
        </div>
        {models.slice(0, 6).map((m, i) => {
          const angle = (i / Math.min(6, models.length)) * Math.PI * 2 - Math.PI / 2;
          const r = 32;
          return (
            <div key={m.id} className="absolute w-2 h-2 rounded-full" style={{ background: m.color, top: `calc(50% + ${Math.sin(angle) * r}px - 4px)`, left: `calc(50% + ${Math.cos(angle) * r}px - 4px)`, boxShadow: '0 0 0 2px #FAF9F5' }} />
          );
        })}
      </div>
      <p className="brand text-[20px] mb-2" style={{ color: '#1A1815' }}>对比视图</p>
      <p className="text-[13px] leading-relaxed max-w-[320px]" style={{ color: '#6F6E5E' }}>
        提一个问题，让 <span style={{ color: '#CC785C', fontWeight: 600 }}>{models.length}</span> 个模型同时回答，
        这里会按下列维度自动总结差异。
      </p>

      {dimensions && dimensions.length > 0 && (
        <div className="mt-6 w-full max-w-[360px]">
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: '#9D9685' }}>当前维度</span>
            <button
              onClick={onOpenSettings}
              className="text-[11px] flex items-center gap-1 transition-colors"
              style={{ color: '#CC785C' }}
            >
              调整 →
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 justify-center">
            {dimensions.map((d, i) => (
              <span
                key={i}
                className="text-[11px] px-2.5 py-1 rounded-full"
                style={{ background: '#FFFFFF', color: '#3D3829', border: '1px solid var(--border-soft)' }}
                title={d.hint || ''}
              >
                {d.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {summaryModelMeta && (
        <div className="mt-5 flex items-center gap-1.5 font-mono text-[10px] px-2.5 py-1.5 rounded-full" style={{ color: '#9D9685', background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
          分析模型
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: summaryModelMeta.color }} />
          <span style={{ color: '#6F6E5E' }}>{summaryModelMeta.name}</span>
        </div>
      )}
    </div>
  );
}

function SummaryGenerating({ modelName, compact }) {
  return (
    <div className={compact ? 'space-y-2 fade-up' : 'px-5 py-5 space-y-4 fade-up'}>
      <div className="flex items-center gap-2 text-xs font-mono" style={{ color: '#CC785C' }}>
        <Loader2 className="w-3 h-3 animate-spin" />
        {modelName ? `${modelName} 正在分析...` : '分析中...'}
      </div>
      {!compact && ['核心共识', '主要分歧', '角度与深度差异', '风格差异'].map((title, idx) => (
        <div key={idx} className="space-y-2">
          <div className="h-4 rounded animate-pulse" style={{ width: '30%', background: '#E8E2D2', animationDelay: `${idx * 100}ms` }} />
          <div className="space-y-1.5">
            {[1, 0.9, 0.7].map((w, i) => (
              <div key={i} className="h-3 rounded animate-pulse" style={{ width: `${w * 100}%`, background: '#F5F1E8', animationDelay: `${idx * 100 + i * 80}ms` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function IdleHint({ modelName }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-8 py-12">
      <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4" style={{ border: '1px solid #E8E2D2' }}>
        <MessageSquare className="w-5 h-5" style={{ color: '#BFB8A8' }} />
      </div>
      <p className="text-lg mb-2 title-cn" style={{ color: '#6F6E5E' }}>等待提问</p>
      <p className="font-mono text-[11px] leading-relaxed" style={{ color: '#9D9685' }}>
        在下方输入框中提问后，<br /><span style={{ color: '#6F6E5E' }}>{modelName}</span> 的回答将显示在这里
      </p>
    </div>
  );
}

function LoadingState({ color }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const hint = elapsed < 10 ? '生成中…'
    : elapsed < 30 ? '思考中…'
    : elapsed < 60 ? '稍慢，请耐心等待…'
    : '深度思考中，可能需要 1~2 分钟…';
  return (
    <div className="space-y-3 fade-up">
      <div className="flex items-center gap-2 text-xs font-mono" style={{ color: '#6F6E5E' }}>
        <Loader2 className="w-3 h-3 animate-spin" style={{ color }} />
        <span>{hint}</span>
        <span className="ml-auto" style={{ color: '#9D9685' }}>已花 {elapsed}s</span>
      </div>
      <div className="space-y-2">
        {[1, 0.8, 0.95, 0.6, 0.85].map((w, i) => (
          <div key={i} className="h-3 rounded animate-pulse" style={{ width: `${w * 100}%`, animationDelay: `${i * 120}ms`, background: '#E8E2D2' }} />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry, retrying }) {
  return (
    <div className="fade-up">
      <div className="flex items-start gap-2.5 p-3 rounded-lg" style={{ background: '#FDEDE8', border: '1px solid #F5D5CC' }}>
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium mb-1" style={{ color: '#b91c1c' }}>请求失败</div>
          <div className="text-[11px] font-mono break-all" style={{ color: '#dc2626' }}>{message}</div>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            disabled={retrying}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{ background: '#FFFFFF', color: '#b91c1c', border: '1px solid #F5D5CC' }}
            title="重新调用这个模型（消耗 1 次配额）"
          >
            <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} /> 重试
          </button>
        )}
      </div>
    </div>
  );
}

function renderInline(text) {
  // 转义 HTML 字符
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 行内格式：粗体 / 斜体 / 行内代码 / 链接
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

// 解析表格行：| a | b | c | → ['a','b','c']
function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

// 判断一行是否是表格分隔行：| --- | :---: | ---: |
function isTableSeparator(line) {
  const s = line.trim();
  if (!s.includes('|') || !s.includes('-')) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(s);
}

// 从分隔行解析对齐：left/center/right
function parseTableAligns(sepLine) {
  return parseTableRow(sepLine).map(cell => {
    const t = cell.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    return 'left';
  });
}

// 如果一行内嵌了「换行被吃掉的表格」（如 `| h | h ||---|---|| a | a |`），把它拆成多行
function explodeInlineTable(line) {
  // 检测特征：包含 `||---` 或 `|---|---|` 等连续分隔模式
  if (!/\|\s*-{3,}/.test(line)) return [line];
  // 在每个 `||` 边界（一行表格的结束 + 下一行开始）切分
  // 思路：当遇到 `|---...---|` 分隔结构，前后断开
  const parts = line
    .replace(/\|\s*(:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+)\|/g, '\n|$1|\n')  // 分隔行独立成一行
    .replace(/\|\s*\|/g, '|\n|')  // `||` → 行结束 + 行开始
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [line];
}

function ResponseText({ text }) {
  if (!text) return null;
  // 预处理：把"行内表格"还原成多行
  const rawLines = text.split('\n');
  const lines = [];
  for (const l of rawLines) lines.push(...explodeInlineTable(l));

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 表格（先于其它检测）
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line);
      const aligns = parseTableAligns(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && !isTableSeparator(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, aligns, rows });
      continue;
    }
    // 水平线
    if (/^---+$/.test(line.trim())) { blocks.push({ type: 'hr' }); i++; continue; }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }
    // 空行
    if (line.trim() === '') { blocks.push({ type: 'br' }); i++; continue; }
    // 普通段落（合并连续非空行）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|---+$|\|)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push({ type: 'p', text: buf.join('\n') });
  }
  return (
    <div className="fade-up" style={{ color: '#2A2620', fontSize: 14, lineHeight: 1.75, wordWrap: 'break-word' }}>
      {blocks.map((b, idx) => {
        if (b.type === 'hr') return <hr key={idx} style={{ border: 'none', borderTop: '1px solid #EFE9DB', margin: '14px 0' }} />;
        if (b.type === 'h') {
          const sizes = { 1: 18, 2: 16, 3: 15, 4: 14, 5: 13, 6: 13 };
          return <div key={idx} style={{ fontSize: sizes[b.level], fontWeight: 600, color: '#1A1815', margin: '16px 0 6px' }} dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />;
        }
        if (b.type === 'ul') return (
          <ul key={idx} style={{ listStyle: 'disc', paddingLeft: 22, margin: '6px 0' }}>
            {b.items.map((it, k) => <li key={k} style={{ margin: '3px 0' }} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />)}
          </ul>
        );
        if (b.type === 'ol') return (
          <ol key={idx} style={{ listStyle: 'decimal', paddingLeft: 22, margin: '6px 0' }}>
            {b.items.map((it, k) => <li key={k} style={{ margin: '3px 0' }} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />)}
          </ol>
        );
        if (b.type === 'quote') return (
          <blockquote key={idx} style={{ borderLeft: '2px solid #E5C5A0', padding: '0 12px', margin: '10px 0', color: '#6F6E5E', fontSize: 13.5, fontStyle: 'italic' }} dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
        );
        if (b.type === 'br') return <div key={idx} style={{ height: 4 }} />;
        if (b.type === 'table') return (
          <div key={idx} style={{ margin: '10px 0', overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 13 }}>
              <thead style={{ background: '#F5F1E8' }}>
                <tr>
                  {b.headers.map((h, k) => (
                    <th key={k} style={{ padding: '6px 12px', border: '1px solid #EFE9DB', textAlign: b.aligns[k] || 'left', color: '#1A1815', fontWeight: 600, verticalAlign: 'top' }} dangerouslySetInnerHTML={{ __html: renderInline(h) }} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, k) => (
                      <td key={k} style={{ padding: '6px 12px', border: '1px solid #EFE9DB', textAlign: b.aligns[k] || 'left', verticalAlign: 'top' }} dangerouslySetInnerHTML={{ __html: renderInline(cell) }} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        return <p key={idx} style={{ margin: '6px 0' }} dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />;
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-8 py-12">
      <p className="text-lg mb-2 title-cn" style={{ color: '#6F6E5E' }}>暂无可用模型</p>
      <p className="font-mono text-[11px]" style={{ color: '#9D9685' }}>服务端配置异常，请联系管理员</p>
    </div>
  );
}

function Footer() {
  return (
    <footer className="px-4 pb-3 shrink-0" style={{ background: '#FAF9F5' }}>
      <p className="font-mono text-[10px] text-center" style={{ color: '#BFB8A8' }}>
        每个 IP 每日 100 次 · 单对话最多 {MAX_TURNS} 轮 · 北京时间 0 点重置
      </p>
    </footer>
  );
}

// ============================================================
// 设置弹窗（沿用旧版）
// ============================================================
function SettingsDrawer({ open, models, systemPrompt, summaryModelId, enabledIds, dimensions, onChangeSystemPrompt, onChangeSummaryModelId, onChangeEnabledIds, onChangeDimensions, onClose }) {
  const [tab, setTab] = useState('dims');
  return (
    <>
      {/* 窄屏遮罩 */}
      {open && <div className="fixed inset-0 z-40 xl:hidden" style={{ background: 'rgba(40,32,24,0.35)' }} onClick={onClose} />}
      <aside
        className={`shrink-0 flex flex-col xl:static xl:translate-x-0 fixed top-0 right-0 bottom-0 z-50 transform transition-transform xl:transition-none ${open ? 'translate-x-0' : 'translate-x-full xl:translate-x-0'}`}
        style={{ width: 360, maxWidth: '95vw', background: '#FAF9F5', borderLeft: '1px solid var(--border-hair)' }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-hair)' }}>
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4" style={{ color: '#CC785C' }} />
            <span className="brand text-[15px]" style={{ color: '#1A1815' }}>设置</span>
          </div>
          {/* 窄屏才显示关闭按钮，宽屏常驻不需要 */}
          <button
            onClick={onClose}
            className="xl:hidden w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: '#9D9685' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F5F1E8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          ><X className="w-4 h-4" /></button>
        </div>

        <div className="grid grid-cols-4 px-3 pt-3 gap-1 pb-3" style={{ borderBottom: '1px solid var(--border-hair)' }}>
          <SettingTab active={tab === 'dims'} onClick={() => setTab('dims')}>
            <ListChecks className="w-3.5 h-3.5" /> 维度
          </SettingTab>
          <SettingTab active={tab === 'compare'} onClick={() => setTab('compare')}>
            <GitCompare className="w-3.5 h-3.5" /> 对比
          </SettingTab>
          <SettingTab active={tab === 'models'} onClick={() => setTab('models')}>
            <Sparkles className="w-3.5 h-3.5" /> 模型
          </SettingTab>
          <SettingTab active={tab === 'prompt'} onClick={() => setTab('prompt')}>
            <User className="w-3.5 h-3.5" /> 角色
          </SettingTab>
        </div>

        <div className="flex-1 overflow-y-auto custom-scroll p-5">
          {tab === 'prompt' && <SystemPromptEditor value={systemPrompt} onChange={onChangeSystemPrompt} />}
          {tab === 'models' && <ModelsList models={models} enabledIds={enabledIds} onChange={onChangeEnabledIds} />}
          {tab === 'compare' && <ComparisonConfig models={models} selectedId={summaryModelId} onChange={onChangeSummaryModelId} />}
          {tab === 'dims' && <DimensionsEditor dimensions={dimensions} onChange={onChangeDimensions} />}
        </div>

        <div className="px-5 py-3 font-mono text-[10px]" style={{ color: '#9D9685', borderTop: '1px solid var(--border-hair)' }}>
          所有改动自动保存（浏览器本地）
        </div>
      </aside>
    </>
  );
}

function DimensionsEditor({ dimensions, onChange }) {
  const update = (i, key, v) => {
    const next = dimensions.map((d, idx) => idx === i ? { ...d, [key]: v } : d);
    onChange(next);
  };
  const remove = (i) => onChange(dimensions.filter((_, idx) => idx !== i));
  const add = () => onChange([...dimensions, { title: '', hint: '' }]);
  const reset = () => onChange([...DEFAULT_DIMENSIONS]);
  const apply = (preset) => onChange(preset.dims.map(d => ({ ...d })));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= dimensions.length) return;
    const next = [...dimensions];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs leading-relaxed" style={{ color: '#6F6E5E' }}>
          每次"对比"会让分析模型按下面这些维度做分类。可改标题、提示语，或增删条目。
        </p>
      </div>

      <div>
        <label className="font-mono text-[10px] tracking-widest uppercase mb-2 block" style={{ color: '#9D9685' }}>快速套用</label>
        <div className="flex gap-1.5 flex-wrap">
          {DIMENSION_PRESETS.map(p => {
            const active = dimsEqual(dimensions, p.dims);
            return (
              <button
                key={p.name}
                onClick={() => apply(p)}
                className="text-[11px] px-2.5 py-1.5 rounded-md transition-colors"
                style={{
                  border: `1px solid ${active ? '#CC785C' : 'var(--border-soft)'}`,
                  color: active ? '#CC785C' : '#6F6E5E',
                  background: active ? '#F5EBDD' : '#FFFFFF',
                }}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        {dimensions.map((d, i) => {
          const isFirst = i === 0;
          const isLast = i === dimensions.length - 1;
          return (
            <div key={i} className="card p-3 fade-up">
              <div className="flex items-center gap-2 mb-2">
                <div className="flex flex-col" style={{ marginLeft: -4 }}>
                  <button
                    onClick={() => move(i, -1)}
                    disabled={isFirst}
                    className="w-5 h-4 flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ color: '#9D9685' }}
                    onMouseEnter={(e) => { if (!isFirst) { e.currentTarget.style.background = '#F5F1E8'; e.currentTarget.style.color = '#CC785C'; } }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9D9685'; }}
                    title="上移"
                  >
                    <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={isLast}
                    className="w-5 h-4 flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ color: '#9D9685' }}
                    onMouseEnter={(e) => { if (!isLast) { e.currentTarget.style.background = '#F5F1E8'; e.currentTarget.style.color = '#CC785C'; } }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9D9685'; }}
                    title="下移"
                  >
                    <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
                  </button>
                </div>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ color: '#CC785C', background: '#F5EBDD' }}>#{i + 1}</span>
                <input
                  value={d.title}
                  onChange={(e) => update(i, 'title', e.target.value)}
                  placeholder="维度名（必填）"
                  className="flex-1 bg-transparent text-[13px] font-medium focus:outline-none"
                  style={{ color: '#1A1815' }}
                />
                <button
                  onClick={() => remove(i)}
                  className="w-6 h-6 rounded flex items-center justify-center transition-colors"
                  style={{ color: '#9D9685' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#FDEDE8'; e.currentTarget.style.color = '#dc2626'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9D9685'; }}
                  title="删除"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <textarea
                value={d.hint || ''}
                onChange={(e) => update(i, 'hint', e.target.value)}
                placeholder="提示语（可选）—— 告诉模型这个维度要怎么分析"
                rows={2}
                className="w-full bg-transparent text-[12px] leading-relaxed resize-none focus:outline-none placeholder:text-[#BFB8A8]"
                style={{ color: '#3D3829' }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={add}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{ background: '#FFFFFF', color: '#CC785C', border: '1px solid var(--border-soft)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#F5EBDD'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
        >
          <Plus className="w-3.5 h-3.5" /> 添加维度
        </button>
        <button
          onClick={reset}
          className="px-3 py-1.5 rounded-lg text-xs transition-colors"
          style={{ color: '#9D9685' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#6F6E5E'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#9D9685'; }}
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}

function SettingTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-full text-[12px] font-medium transition-all whitespace-nowrap"
      style={{
        color: active ? '#CC785C' : '#6F6E5E',
        background: active ? '#F5EBDD' : 'transparent',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(60,50,40,0.04)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function ModelsList({ models, enabledIds, onChange }) {
  const toggle = (id) => {
    if (enabledIds.includes(id)) onChange(enabledIds.filter(x => x !== id));
    else onChange([...enabledIds, id]);
  };
  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed mb-2" style={{ color: '#6F6E5E' }}>
        选择本次提问要使用的模型。模型配置由服务端管理，你只能选启用与否。
      </p>
      {models.map(m => {
        const enabled = enabledIds.includes(m.id);
        return (
          <div key={m.id} className="flex items-center gap-3 px-4 py-3 rounded-lg" style={{ border: '1px solid #EFE9DB', background: '#ffffff' }}>
            <button onClick={() => toggle(m.id)} className="w-8 h-4 rounded-full relative transition-colors shrink-0" style={{ background: enabled ? m.color : '#D6CFBE' }}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }} />
            </button>
            <div className="w-2 h-2 rounded-full" style={{ background: m.color }} />
            <span className="font-medium text-sm" style={{ color: '#1A1815' }}>{m.name}</span>
            <span className="font-mono text-[10px]" style={{ color: '#9D9685' }}>{m.model}</span>
          </div>
        );
      })}
    </div>
  );
}

function ComparisonConfig({ models, selectedId, onChange }) {
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed" style={{ color: '#6F6E5E' }}>
        多个模型同时回答后，由此模型负责分析它们的核心差异。建议选择推理能力较强的模型。
      </p>
      <div>
        <label className="font-mono text-[10px] tracking-widest uppercase mb-2.5 block" style={{ color: '#9D9685' }}>分析模型</label>
        <div className="space-y-1.5">
          {models.map(m => {
            const selected = selectedId === m.id;
            return (
              <button key={m.id} onClick={() => onChange(m.id)} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all text-left" style={{ background: selected ? '#F5F1E8' : '#ffffff', border: `1.5px solid ${selected ? '#CC785C' : '#EFE9DB'}` }}>
                <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ border: `2px solid ${selected ? '#CC785C' : '#D6CFBE'}`, background: selected ? '#CC785C' : 'transparent' }}>
                  {selected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: m.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-sm" style={{ color: '#1A1815' }}>{m.name}</span>
                    <span className="font-mono text-[10px] truncate" style={{ color: '#9D9685' }}>{m.model}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SystemPromptEditor({ value, onChange }) {
  const update = (key, v) => onChange({ ...value, [key]: v });
  const presets = [
    { name: '产品经理视角', role: '你是一位有 5 年经验的资深产品经理，擅长从用户价值和商业可行性两个维度分析问题。', context: '', instructions: '回答时请给出可执行的建议，避免抽象理论。' },
    { name: '严谨学者', role: '你是一位严谨的学者，习惯引用研究和数据来支撑观点。', context: '', instructions: '请明确区分事实、观点和推断；若信息不确定请明确说明。' },
    { name: '简洁直接', role: '', context: '', instructions: '回答尽可能简洁，避免铺垫，直接给出结论和核心理由。控制在 200 字以内。' },
  ];
  const isEmpty = !value.role && !value.context && !value.instructions;
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed" style={{ color: '#6F6E5E' }}>
        配置所有模型回答问题时遵循的统一设定。三个字段都是可选的。
      </p>
      <div>
        <label className="font-mono text-[10px] tracking-widest uppercase mb-2 block" style={{ color: '#9D9685' }}>快速套用</label>
        <div className="flex gap-1.5 flex-wrap">
          {presets.map(p => (
            <button key={p.name} onClick={() => onChange({ role: p.role, context: p.context, instructions: p.instructions })} className="text-xs px-2.5 py-1.5 rounded-md" style={{ border: '1px solid #E8E2D2', color: '#6F6E5E', background: '#ffffff' }}>
              {p.name}
            </button>
          ))}
          {!isEmpty && (
            <button onClick={() => onChange(DEFAULT_SYSTEM_PROMPT)} className="text-xs px-2.5 py-1.5 rounded-md flex items-center gap-1" style={{ color: '#dc2626' }}>清空</button>
          )}
        </div>
      </div>
      <PromptField icon={<User className="w-3.5 h-3.5" />} label="角色" sub="ROLE" value={value.role} onChange={(v) => update('role', v)} placeholder="例：你是一位资深产品经理..." rows={2} />
      <PromptField icon={<BookOpen className="w-3.5 h-3.5" />} label="背景" sub="CONTEXT" value={value.context} onChange={(v) => update('context', v)} placeholder="例：我们正在讨论 GEO 行业的产品策略..." rows={3} />
      <PromptField icon={<ListChecks className="w-3.5 h-3.5" />} label="要求" sub="INSTRUCTIONS" value={value.instructions} onChange={(v) => update('instructions', v)} placeholder="例：用简洁的中文回答，控制在 300 字以内" rows={4} />
    </div>
  );
}

function PromptField({ icon, label, sub, value, onChange, placeholder, rows }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span style={{ color: '#CC785C' }}>{icon}</span>
        <label className="text-xs font-medium" style={{ color: '#2A2620' }}>{label}</label>
        <span className="font-mono text-[9px] tracking-widest" style={{ color: '#BFB8A8' }}>{sub}</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-lg px-3 py-2.5 text-xs leading-relaxed resize-none focus:outline-none transition-colors"
        style={{ background: '#ffffff', border: `1px solid ${focused ? '#CC785C' : '#E8E2D2'}`, color: '#2A2620' }}
      />
    </div>
  );
}
