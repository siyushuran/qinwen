# 轻问练 · AI 陪练 —— 部署说明

> 基于《AI陪练网页项目方案.md》实现的个人自用 PWA：说想学什么，AI 拆出知识清单，逐题现写现练，答完即讲。

## 架构

```
浏览器 PWA ──HTTP──▶ 单后端服务（Node 24，零依赖）
                     ├─ API 路由 + SSE 流式追问
                     ├─ 模型抽象层（OpenAI 兼容，配置化切换）
                     ├─ SQLite 单文件（node:sqlite 内置，数据落盘持久化）
                     └─ 同进程托管前端 SPA 静态文件
```

## 已实现功能（覆盖方案 M0–M4 的资料与学情核心；TTS/ASR 未做）

- 单用户访问密码（scrypt 哈希存储，Bearer Token 鉴权）
- 资料库（M4）：粘贴文章/Markdown → 按标题切块 → 生成摘要、按资料拆清单、接地问答、资料出题
- 记忆宫殿复习卡：一间房 + 一条意象 + 一条自测线索，先回忆后揭示，自评直接驱动间隔复习
- 多文档交叉核验：跨资料召回同一主张的原文，逐条标注支持/矛盾/无关；伪引用会被丢弃
- 排序题与图片资料：选项点选排序（答案有序、顺序错即判错）；上传截图由视觉模型转成可检索资料
- 创建领域 → AI 拆知识清单（构建过程拟人化可视化，清单可增删）
- 出题（单选/判断，落库缓存复用，下发数据不含答案）→ 提交作答后才判分并高亮对错 + AI 讲解
- 错因标签（概念不清/计算失误/审题偏差/纯手滑），作答后补记并保存，错题本可按错因筛选
- 地图/复习/错题本可直达对应知识点或指定题目（错题「重练这题」）
- 创建领域时选择的起始基础真正参与 AI 拆解清单
- 掌握度记录 + 简化间隔复习调度（答对延长间隔、答错次日重练）
- 追问面板（SSE 流式，苏格拉底式引导，不直接报答案）
- 做题进度按领域保存（知识点/题目/难度），重新进入练习页接着练，不从头开始
- 答对后主推「出下一题」：按知识点顺序推进，跳过本轮已见过的题（仅有一个知识点时现场出新题）
- 快捷操作：出个类似的 / 同层换新 / 换个方向
- 知识地图（掌握度着色）、复习队列、错题本、学习报告（真实数据日历）
- 全局字号 5 档、动效两档（首帧防闪烁）、助手昵称与兴趣场景配置
- 模型配置（Base URL / API Key / 主力模型 / 快速模型，设置页可改；输入框留空表示保持原值，清空需显式操作）
- PWA manifest（加到主屏，不做离线缓存）
- 数据导出（一致性 SQLite 快照，自动剔除令牌/密码哈希/模型密钥）
- 降级原则：模型未配置/不可达时明确报错，不放假数据

## 目录结构

```
qingwen-practice/
├── server/server.mjs           # 后端（零依赖，Node 24 内置 node:sqlite）
├── server/*-test.mjs           # 端到端测试（含 phase2-test.mjs，临时库 + 模拟模型）
├── server/seed-article.mjs     # 一次性资料导入脚本
├── web/                        # 前端源码（Vite + React）
│   ├── src/pages/              # 含 Materials.jsx / MaterialDetail.jsx / Palace.jsx
│   ├── public/                 # manifest / icon
│   └── dist/                   # 构建产物（部署用，本地生成后手动上传 NAS，不进 Git）
├── docker-compose.yml          # NAS 部署配置
└── README.md
```

## NAS 部署（fnOS 飞牛，Docker）

部署位置：`/vol2/1000/DOCKER/qingwen-practice/`

- 容器：`qingwen-practice`，镜像 `node:24-alpine`
- 端口映射：宿主 `18321` → 容器 `3000`
- 数据持久化：`./server` 目录挂载到 `/app/server`，SQLite 文件在 `server/data/qingwen.db`
- 重启策略：`unless-stopped`（NAS 重启后自动拉起）

### 本地开发

```bash
# 后端（需 Node 24+）
cd server && PORT=3000 node server.mjs

# 前端
cd web && npm install && npm run dev   # 开发
cd web && npm run build                # 构建到 dist/

# 端到端测试（均为临时库 + 模拟模型，不影响线上数据）
node server/smoke-test.mjs          # 主流程与关键边界
node server/bank-import-test.mjs    # 题库导入幂等与出题
node server/material-test.mjs       # 资料入库/摘要/清单/出题/问答/划线
node server/highlight-test.mjs      # 划线增删改查/搜索/导出
node server/phase2-test.mjs         # 排序题/记忆卡/交叉核验/图片资料

# 部署后静态资源/健康检查验证
node verify.js <目标地址> <web/dist路径> <结果输出路径>
```

## 访问方式

1. **日常访问（反代）**：`https://qw.icge.top:1487`
   - 已配置反向代理，将请求转发到容器 `http://qingwen-practice:3000`（宿主 `http://<NAS内网IP>:18321`）。
   - 容器端口 18321 不直接对公网开放，公网请始终使用上述 HTTPS 地址。
2. **局域网直连（备用）**：`http://<NAS内网IP>:18321`
   - 若反代不可用，可在 NAS 本地网络上直连；公网直连该端口通常会被网关拒绝。
3. **首次进入**：设置访问密码 → 创建领域 → AI 拆解清单 → 开始练习。
4. **使用前必做**：进入「设置」页填写模型配置（Base URL / API Key / 模型名），
   支持 DeepSeek / Kimi / GLM / 通义 / 本地 Ollama 等 OpenAI 兼容接口。

## 关键配置项

| 配置 | 位置 | 说明 |
|---|---|---|
| 端口 18321 | docker-compose.yml / 容器 port 映射 | 可改左侧宿主端口 |
| SQLite 数据 | `/vol2/1000/DOCKER/qingwen-practice/server/data/` | 备份即拷贝该目录 |
| 模型配置 | 应用内「设置」页，存 SQLite setting 表 | 重启生效 |
| 访问密码 | 应用内首次进入设置 | scrypt 哈希存储 |
| 字号/动效 | 应用内「设置」页，localStorage | 即时生效 |

## 安全说明

- 鉴权：密码异步 scrypt 哈希；Bearer Token 常量时间比较；登录/初始化接口按 IP 限流；退出登录会同步撤销服务端令牌。
- 模型地址：只允许公网 HTTPS；本地 Ollama 等回环 HTTP 例外；拒绝内网/链路本地/云元数据地址，禁止跟随跳转，避免 API Key 被带往任意地址。日志与错误响应不回显上游响应体。
- 数据导出：使用 `VACUUM INTO` 生成一致性快照（WAL 下直接拷贝主库可能是空文件），删除令牌、密码哈希、模型密钥后再 `VACUUM` 重建页面，避免明文残留在空闲页；恢复后需重新设置密码与模型配置。
- 写入可靠性：作答、出题、清单重建、删除均使用 SQLite 事务；同一知识点的出题串行化，避免并发产生重复题或丢失掌握度更新。
- 限流：登录 8 次/10 分钟、初始化 5 次/10 分钟、出题 40 次/分钟（「出下一题」12 次/分钟）、作答 60 次/分钟、拆解 5 次/分钟、追问 20 次/分钟（最多 2 路并发）、导出 5 次/分钟；资料入库/摘要/出题/图片转写/核验/卡片生成各 10 次/分钟、资料问答与卡片自评各 20 次/分钟；模型调用全局最多 2 并发，单知识点题目上限 200 道。

## 外部题库：芒格思维模型（munger-kb）

网站已内置题库导入能力，并把 `https://mungermodels.com/` 的 1290 道客观题导入为领域「芒格思维模型」。题目从知识库真实结构化字段确定性生成（题型 5 类），不调用模型、不编造事实，每题保留 `source_url` 可追溯。

- 结构：1 个 domain（source_key=`munger-kb://domain/munger-models`）→ 14 个学科 facet → 231 个模型知识点 → 1290 道题。
- 题型：attribution 模型→学科 231、english 英文名 138、relation 关联模型 462、summary 摘要→模型 228、judge 判断 231。
- 难度按题型分层（1/2/3），确保每个模型节点都有难度 1 的入口题，网站默认出题即可命中导入题。
- 导入幂等：以 `source_key` 判定已存在对象，只补缺，不删除用户作答/进度；重复导入会跳过已存在的题。
- 出题逻辑不变：`POST /api/questions` 仍优先取缓存题，导入题与 AI 生成题共用同一出题/作答/错题/复习流程，前端无需改动。

管理接口（均需 Bearer Token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bank/stats` | 查看题库统计（领域/知识点/题目数、题型分布） |
| POST | `/api/bank/import` | 导入题目 JSON，body `{questions:[...]}`，幂等 |

题目 JSON 字段：`bank_id`（唯一键）、`domain_name`、`node_name`、`type`、`difficulty`、`stem`、`options`（数组）、`answer`（必须是某个选项原文）、`explanation`、`source_url`、`source_type`、`model`、`prompt_ver`。

本地操作：

```bash
# 1) 在 munger-kb 目录重新生成题库（网站内容更新后）
cd ../munger-kb && python question_bank.py

# 2) 导入到网站（需要网站登录 token）
cd ../qingwen-practice/server
node import-questions.mjs ../munger-kb/data/export/question_bank.jsonl \
  --url https://qw.icge.top:1487 --token '<网站token>' --batch 200

# 3) 端到端验证（临时库，不影响线上）
node bank-import-test.mjs
```

## 资料库（文章 / Markdown 接入）

「资料」页可粘贴公众号文章正文或 Markdown。服务端按标题层级切块（单块约 1200 字），存 `material` / `material_chunk` 两张表；后续摘要、清单、出题、问答都带出处编号。导入时 `claim_policy` 可选 `article_claim`（争议内容按「文章称」口径，默认且推荐）、`verified`、`mixed`。

- 摘要：ASD-STE100 简化风格，输出一句话 + 要点 + 时间线，用快速模型生成并缓存。
- 按资料拆清单：只依据资料正文生成「知识面 → 知识点」，可一键创建领域。
- 资料出题：围绕知识点生成单选/判断题，解析强制引用资料编号，落库后走既有练习/错题/复习闭环。
- 资料问答：SSE 流式，先按中文双字 + 英文词做关键词召回（无需 embedding / 向量库），再要求模型仅依据片段作答并标注引用；资料没写就明确说不知道。
- 划线：原文片段与回答都可划线，导出 Markdown 时带原文链接。

API（均需 Bearer Token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/materials` | 资料列表（含切块数与关联领域） |
| POST | `/api/materials` | 入库并切块，body `{title, content, source_url, domain_id, claim_policy}` |
| POST | `/api/materials/image` | 图片 data URL → 视觉模型转写为资料，body `{image, title, hint, domain_id}`；原图落在 `server/data/uploads/` |
| POST | `/api/materials/verify` | 跨资料交叉核验，body `{claim, material_ids?}`；引用必须逐字命中原文 |
| GET | `/api/materials/:id` | 资料详情与全部分块 |
| DELETE | `/api/materials/:id` | 删除资料与分块（保留已生成题目） |
| POST | `/api/materials/:id/summary` | 生成/读取摘要（缓存） |
| POST | `/api/materials/:id/build` | 按资料拆清单并创建或复用领域 |
| POST | `/api/materials/:id/questions` | 按资料生成题目，body `{node_id?, count, difficulty}` |
| POST | `/api/materials/:id/chat` | 资料问答（SSE，首帧为引用来源） |

题库导入已通用化：`POST /api/bank/import` 可选传 `domain_name`、`domain_key`、`source_key_prefix`、`domain_source`，缺省仍为 `munger-kb`，不影响既有芒格题库。`GET /api/bank/stats?prefix=...&domain_key=...` 可按前缀查看统计。

排序题：`POST /api/questions` 传 `{type:'order'}`、`POST /api/materials/:id/questions` 传 `{type:'order'}` 即生成排序题。`answer` 是有序的选项原文数组（库内存 JSON 字符串），提交时传同样的 JSON 数组；顺序完全一致才判对，返回 `correct_order` 与 `first_wrong`。题库导入仍只接受单选/判断，不会污染既有 1290 题。

一次性导入文章（需要网站登录 token）：

```bash
QW_TOKEN='<网站token>' node server/seed-article.mjs https://qw.icge.top:1487 ../outputs/qinwen-article-learning-material.md [领域名]
```

令牌也可从只读数据库副本读取，避免在命令行暴露：`QW_DB=/path/to/qingwen.db node server/seed-article.mjs ...`。`SEED_RESULT_FILE=<路径>` 可把非敏感导入结果写入文件供容器外验证，验证后必须删除。

验证：`node server/material-test.mjs`（临时库 + 模拟模型，覆盖入库/摘要/清单/出题/问答/划线/通用导入）。

## 记忆宫殿与交叉核验

记忆宫殿卡把知识点放进一间具体的「房间」，用意象做位置线索，先看 `cue` 自测、再揭示 `answer`。卡片生成结果按知识点缓存（一个知识点一张），自评「记住/没记住」与作答走同一套 `review_slot` 调度。资料未覆盖时卡片只基于知识点名称生成，不伪装成原文依据。

交叉核验先对每篇资料按主张做关键词召回，再让模型判断支持/矛盾/无关。服务端强制校验 `material_id` / `idx` 必须来自真实召回片段、`quote` 必须是片段中的逐字原文，否则丢弃该条；口径为 `article_claim` 的结论自动加「文章称」。

API（均需 Bearer Token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/memory-cards` | 卡片列表（含到期时间与来源知识点） |
| POST | `/api/memory-cards/generate` | 生成卡片，body `{node_id?, material_id?, count?}`；不传则从到期知识点生成 |
| POST | `/api/memory-cards/:id/review` | 自评，body `{remembered: true/false}`，返回下次到期时间 |

前端入口：复习页「🏛️ 记忆宫殿」，资料详情页「生成记忆卡」；资料页「🖼️ 图片转资料」与「🔍 多文档交叉核验」。

## 划线收藏

在题目卡里选中**题干、作答后的讲解、AI 追问回复**中的任意文字，浮出的「✍️ 划线收藏」按钮会把原句存入划线本；已划线的句子在原处高亮显示。用于收集题库或资料片段里值得回看的句子。

- 入口：底部导航「划线」，或 `#/highlights`
- 每条划线可加备注、按领域/关键词筛选、跳转到来源知识点或原始网页、删除
- 「导出」按钮下载 Markdown（`highlights.md`），方便归档到笔记软件
- 划线来源（题干/讲解/追问）与来源题目、原始网页链接由服务端从题目反查写入，客户端无法伪造

API（均需 Bearer Token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/highlights?q=&domain_id=&limit=&offset=` | 列表，可按内容/备注/题干搜索、按领域过滤 |
| POST | `/api/highlights` | 新增，body `{text, source, question_id, note}` |
| PATCH | `/api/highlights/:id` | 改备注 |
| DELETE | `/api/highlights/:id` | 删除 |
| GET | `/api/highlights/export` | 导出 Markdown |

验证：`node server/highlight-test.mjs`（临时库，覆盖增删改查/搜索/导出/来源反查）。
