# 轻问练（qingwen-practice）项目约定

## 命令
- 后端：`cd server && PORT=3000 node server.mjs`（依赖 Node 24 内置 `node:sqlite`；本机 Node 22，线上 node:24-alpine，以线上为准）
- 前端：`cd web && npm install && npm run dev`；`npm run build` 产出 `web/dist/`（被 .gitignore 忽略，不进 Git），由后端同进程托管；部署需手动上传新 assets 并删除旧哈希文件
- 测试（临时库 + 模拟模型，不影响线上）：`node server/smoke-test.mjs`、`node server/bank-import-test.mjs`、`node server/material-test.mjs`、`node server/highlight-test.mjs`、`node server/phase2-test.mjs`、`node server/difficulty-test.mjs`、`node server/adaptive-test.mjs`
- 部署校验：`node verify.js <URL> <web/dist路径> <结果路径>`，从 dist/index.html 动态发现资源
- 一次性文章导入：`QW_TOKEN=<token> node server/seed-article.mjs <站点URL> <资料.md> [领域名]`；令牌也可由 `QW_DB=<只读库副本>` 从 setting 表读取

## 架构
- 单进程 Node：API + SSE + OpenAI 兼容模型抽象 + SQLite 单文件 + 静态托管 `web/dist`
- 数据：`server/data/qingwen.db`（WAL）；`material`/`material_chunk` 存文章快照与切块；`question`/`chat_turn`/`highlight` 带 `material_id`，题目与划线另有 `chunk_id`
- 资料流：粘贴 Markdown 或图片 data URL → 标题切块（约 1200 字）→ 摘要/清单/出题/SSE 问答；中文双字词 + 英文词关键词召回，不引向量库；回答强制带引用编号，争议按「文章称」
- 记忆卡：`memory_card` 按 node_id 唯一缓存「房间/意象/线索/答案」，自评写回 `review_slot`；交叉核验不建表，只做跨资料召回 + 逐条引用校验
- 排序题：`type='order'`，answer 与提交值均为选项原文的 JSON 有序数组；前端点选排序，顺序全对才算对
- 题库导入幂等靠 `source_key` 前缀，默认 `munger-kb://`；其他来源显式传 `domain_name`/`domain_key`/`source_key_prefix`/`domain_source`
- 自适应难度：`/api/difficulty/advice` 直接查 `attempt`+`question`，前 3 题定档、同档连对升/连错降、否则近 10 题正确率；前端 `qw_auto_difficulty` 控制自动，手动点档位会关闭
- 学情：`/api/stats` 的 `weak_nodes` 按知识点聚合（≥2 次作答），`/api/review` 按逾期 + 薄弱度 + 近 7 天错次排序，均不新增表

## Things That Will Bite You
- `/api/chat` 只接受 `question_id`；资料问答必须走 `POST /api/materials/:id/chat`
- 排序题的 answer 不能塞进 `answerIndex()`；缓存题按 type 分流，避免「出排序题」拿到旧单选题
- 交叉核验的 `quote` 必须逐字命中召回片段、`material_id/idx` 必须来自真实片段，否则整条丢弃；`article_claim` 自动加「文章称」
- 图片只收 data URL（PNG/JPEG/WebP/GIF、3MB 内），原图存 `DATA_DIR/uploads/` 经 `/uploads/<hash>.<ext>` 托管；模型不支持 vision 时明确报 502，不编造描述
- 出题接口不下发 `answer`/`explanation`，提交作答后才返回 `correct_index`
- 难度建议的连对/连错必须在**同一难度档**内累计，跨档不接续；`/api/review` 返回的是 `nd.*`，节点主键字段是 `id` 不是 `node_id`
- 可选整数查询参数不要用带默认值的 `intIn()` 钳制（曾把缺失的 `domain_id` 钳成 1，划线全被过滤）
- 模型 Base URL 仅公网 HTTPS（回环 HTTP 例外），拒绝内网/元数据地址与跳转；API Key 不写进代码、文档或输出
- NAS 用 fnOS profile `home`：`file upload` 第一参数是远端目录，覆盖必须 `--overwrite replace`（`rename` 会留 `_1` 副本）；Git Bash 传 `/vol2/...` 报 Unsupported path，改用 PowerShell 调 `fnos-cli.cmd`
- 线上 DB 下载链接会被脱敏，拿不到文件；需要 token 时在 NAS 内起临时 node 容器挂载目录读取，用完删除容器与临时结果文件
- 改库前先停容器并备份 `qingwen.db` + `-wal` + `-shm` 到 `backup/`；`web/dist` 文件名带哈希，替换后清掉旧 assets
- 本机 `git push` 偶发 `schannel: failed to receive handshake`；改用 `git -c http.sslBackend=openssl push origin main` 可成功
- `SEED_RESULT_FILE` 只写非敏感结果到静态目录供临时验证，验证后必须删除

## Don't
- 不要把「黎曼猜想已攻克」等文章声明当事实出题；统一 `article_claim / 待核实`
- 不要直接改线上 SQLite；不要暴露宿主 18321 端口（对外只用 `https://qw.icge.top:1487`）
- 不要跳过 `material-test.mjs` 就改资料接口；不要把 `curl -k` 的 200 当部署完成证明，须核对资源哈希
