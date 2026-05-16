# 集思 · SaaS 版

一问多答 · 让多个 AI 模型同时回答并对比差异。

**架构**：
- 前端：纯静态 React，Vite 构建
- 后端：Cloudflare Pages Functions（API 网关 + 配额管理）
- 存储：Cloudflare KV（按 IP 记录每日用量）
- 限流：每个 IP 每天 100 次提问，北京时间 0 点重置

---

## 部署步骤

### 1. 准备 API Keys（先充值，再设上限）

每家拿到一个 Key，然后**在各自后台把月度消费上限设好**（最重要的一步，防被刷爆）：

| 厂商 | 申请地址 | 上限怎么设 |
|---|---|---|
| AiHubMix（Claude） | https://console.aihubmix.com | 充值预算控制 → 自动停服 |
| DeepSeek | https://platform.deepseek.com/api_keys | 设置 → 充值限额 |
| 豆包（火山） | https://console.volcengine.com/ark | 费用中心 → 消费预警 + 自动停服 |
| 通义千问 | https://bailian.console.aliyun.com/ | 费用中心 → 预警与停用 |

建议每家 ¥50~100 的月度上限起步，反正这个工具一个月也用不了多少。

### 2. 注册 Cloudflare

https://dash.cloudflare.com/sign-up - 免费账号即可。

### 3. 创建 KV 命名空间

Cloudflare 控制台 → 左侧 "Storage & Databases" → "KV" → **Create instance**

- 名字：`jisi-quota`（随意，但后面要用）

记下创建后显示的 **Namespace ID**，部署时要用。

### 4. 本地构建

```bash
cd jisi-saas
npm install
npm run build
```

构建产物在 `dist/` 目录。

### 5. 首次部署

```bash
npx wrangler login            # 浏览器跳出登录窗口，登录你的 CF 账号
npx wrangler pages deploy dist --project-name=jisi
```

- 第一次会问你「Create a new project?」→ 回车确认
- 部署完会给一个 URL：`https://jisi.pages.dev`（或类似）

**注意：此时打开 URL 还不能用** —— 因为还没绑定 KV 和环境变量。下一步。

### 6. 在 Cloudflare 控制台配置

打开 Cloudflare 控制台 → **Workers & Pages** → 找到 `jisi` 项目 → **Settings**

#### 6.1 绑定 KV

- "Settings" → "Functions" → "KV namespace bindings" → "Add binding"
- Variable name: `QUOTA_KV`（**必须叫这个名字**，代码里硬编码）
- KV namespace: 选你刚创建的 `jisi-quota`
- 保存

#### 6.2 设置环境变量

- "Settings" → "Environment variables" → "Production" → "Add variable"
- 一个个加（建议都加密：勾选 "Encrypt"）：

| 变量名 | 值 |
|---|---|
| `AIHUBMIX_KEY` | 你 AiHubMix 的 sk-xxx |
| `DEEPSEEK_KEY` | DeepSeek 的 Key |
| `DOUBAO_KEY` | 豆包的 Key |
| `QWEN_KEY` | 通义千问的 Key |

注意：**变量名必须完全一致**，跟 `functions/_shared.js` 里的 `keyEnv` 字段对应。

#### 6.3 触发重新部署

环境变量改完不会自动生效。在 "Deployments" 标签页找到最新部署，点 "Retry deployment"。

或者在本地再跑一次 `npm run deploy`。

### 7. 验证

打开 `https://jisi.pages.dev`：

1. 右上角应该看到 "100 / 100" 的配额徽章
2. 在输入框问任意问题，点发送
3. 等 5~20 秒，4 个 Tab 都出回答，"对比" Tab 出对比分析
4. 配额变成 "99 / 100"

如果某个模型显示「请求失败」+ HTTP 错误码，是 Key 配错了。检查环境变量。

### 8.（可选）绑定自己的域名

Cloudflare Pages → jisi 项目 → "Custom domains" → "Set up a custom domain"

填一个你已经放在 Cloudflare 托管的域名，比如 `jisi.yourname.com`。会自动签证书。

---

## 日常运维

### 部署新版本

修改代码后：

```bash
npm run build
npx wrangler pages deploy dist --project-name=jisi
```

环境变量和 KV 绑定保留，不用重新配。

### 查看用量 / 调试

- 看 KV 内容：CF 控制台 → KV → jisi-quota → 能看到每个 IP-日期 的当日用量
- 看 Function 日志：CF 控制台 → Workers & Pages → jisi → "Functions" → "Logs"
- 看请求量：jisi 项目首页有 "Analytics" 标签

### 改额度

`functions/_shared.js` 里 `DAILY_LIMIT = 100` 这一行改一下，重新部署。

### 加新模型

`functions/_shared.js` 的 `MODELS` 数组里加一项：

```javascript
{
  id: 'glm',
  name: '智谱',
  color: '#0284c7',
  model: 'glm-4',
  provider: 'openai',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  keyEnv: 'ZHIPU_KEY',  // 然后在 CF 控制台加 ZHIPU_KEY 环境变量
}
```

重新部署。前端 `/api/models` 会自动反映。

### 移除模型

从 `MODELS` 数组里删掉对应项就行，前端会自动适配。

---

## 注意事项

### 配额绕过

按 IP 限额并不严格：

- 一个办公室同一公网 IP，所有人共享 100 次
- 用户切换 VPN / 4G / WiFi 网络可以重置
- 公司用 NAT 出口的可能整层楼共用一个 IP

如果有人真的想刷，他刷得动。所以**钱包安全靠厂商后台的消费上限**，不靠这个限流。

### 性能

- 单次 `/api/ask` 走完所有模型 + 对比分析，整体 5~25 秒
- 没做流式响应，用户会盯着 loading 看到所有结果一次性出来
- 想要更好的体验需要改成 SSE 流式，工程量较大

### 成本估算

按 4 模型 + 对比 = 平均 5 次 API 调用 / 提问，token 量 ~3000：

- DeepSeek：~¥0.01
- 豆包：~¥0.02  
- 通义千问：~¥0.02
- Claude（经 AiHubMix）：~¥0.10

单次提问总成本约 **¥0.15**。100 个用户用满（理论上不可能），约 ¥1500/月。
实际预估 ¥50~200/月足够。但**还是请在厂商后台设上限**。

### 安全

- 前端调 `/api/*` 是同源，没有 CORS 暴露
- API Key 只在 CF 环境变量里，不会下发到前端
- KV 里只有 IP 和当日计数，无个人信息
- 没做用户认证、没做日志记录（隐私友好）

---

## 文件结构

```
jisi-saas/
├── README.md                此文件
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── wrangler.toml
├── index.html
├── public/
│   ├── favicon-16.png
│   └── favicon-32.png
├── src/                     ← 前端代码
│   ├── main.jsx
│   ├── App.jsx              主组件
│   ├── api.js               调后端的封装
│   └── styles.css
├── functions/               ← Cloudflare Pages Functions
│   ├── _shared.js           ⭐ 模型配置在这里
│   └── api/
│       ├── models.js        GET /api/models
│       ├── ask.js           ⭐ POST /api/ask（主入口）
│       └── quota.js         GET /api/quota
└── scripts/
    ├── make_icons.py        favicon 生成器
    └── copy-functions.js    把 functions 复制到 dist
```
