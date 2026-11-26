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

## 已实现功能（对齐方案 M0–M3 核心）

- 单用户访问密码（scrypt 哈希存储，Bearer Token 鉴权）
- 创建领域 → AI 拆知识清单（构建过程拟人化可视化，清单可增删）
- 出题（单选/判断，落库缓存复用）→ 作答判定 + AI 讲解
- 错因标签（概念不清/计算失误/审题偏差/纯手滑），错题自动入本
- 掌握度记录 + 简化间隔复习调度（答对延长间隔、答错次日重练）
- 追问面板（SSE 流式，苏格拉底式引导，不直接报答案）
- 快捷操作：出个类似的 / 同层换新 / 换个方向
- 知识地图（掌握度着色）、复习队列、错题本、学习报告（真实数据日历）
- 全局字号 5 档、动效两档（首帧防闪烁）、助手昵称与兴趣场景配置
- 模型配置（Base URL / API Key / 主力模型 / 快速模型，设置页可改）
- PWA manifest（加到主屏，不做离线缓存）
- 数据导出（SQLite 单文件全量备份）
- 降级原则：模型未配置/不可达时明确报错，不放假数据

## 目录结构

```
qingwen-practice/
├── server/server.mjs        # 后端（零依赖，Node 24 内置 node:sqlite）
├── web/                     # 前端源码（Vite + React）
│   ├── src/                 # 页面与组件
│   ├── public/              # manifest / icon
│   └── dist/               # 构建产物（部署用）
├── docker-compose.yml       # NAS 部署配置
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
```

## 访问方式

1. **局域网**：`http://<NAS内网IP>:18321`
2. **公网**：NAS 公网入口仅暴露 1487（fnOS 管理页），容器端口 18321 未直接对公网开放。
   与现有 navidrome / siyuan 等服务一致，需要经反向代理访问：
   - 在 fnOS「Docker」应用或 Lucky 等反向代理工具中新增规则，
     目标指向 `http://<NAS内网IP>:18321`（或容器地址 `http://qingwen-practice:3000`），
   - 或在路由器上为 18321 增加端口转发（注意安全，配合访问密码使用）。
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
