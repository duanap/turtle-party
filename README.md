# 龟牌派对 · Turtle Party

**经典抽乌龟（Old Maid） · v0.3.0** | [English](README.en.md)

轻量级、可联机、支持 AI 补位的浏览器纸牌游戏。**无 Docker、无数据库、无第三方 npm 依赖**，Node.js 20+ 可直接运行。

## 本地运行

```bash
node --version              # >=20
npm start
# 打开 http://127.0.0.1:3000
npm test                     # 24 项 Node.js 自动化测试
```

为了让局域网手机访问（仅限可信测试网络），可以运行 `HOST=0.0.0.0 PORT=3000 npm start`；**不要在公网直接开放 3000 端口**。正式部署建议绑定 `127.0.0.1` 并在 Nginx 前启用 HTTPS。

## 游戏操作

- 快速开始：一名真人和三名 AI 直接开局。
- 创建房间：选择 2～6 人，通过 6 位房间号邀请真人，房主可用 AI 补位。
- 抽牌：点击暗牌选择，再点击确认；对方仅剩一张时直接点击。
- 手牌管理：PC 拖动排列，手机长按约 320ms 拖动；横向滑动牌列浏览；可一键洗序，被抽牌期间锁定。
- 对局结束：共配出 25 对，最后剩下一张乌龟牌的玩家失败。
- 网络与恢复：断线 5 秒后暂由托管随机抽牌；重连自动恢复自己的座位和手牌。服务器重启后尝试从本地快照恢复。

## 当前架构

| 模块 | 技术 |
| --- | --- |
| 前端 | 原生 HTML5 + CSS3 + JavaScript；公共/PC 样式与移动样式分别维护 |
| 服务端 | Node.js 原生 HTTP，原生 JS 游戏规则与 AI |
| 联机 | JSON 操作 API + SSE 服务端推送（通过 fetch 流读取，可发送身份请求头） |
| 弱网 | 指数退避重连、状态轮询兜底、离线保留会话和操作幂等重试 |
| 身份 | 24 字节随机 Bearer 凭证；仅保存服务端 SHA-256 哈希 |
| 数据 | 内存 Map + 本机原子写入 `data/rooms.json`（0600），无数据库 |
| 安全 | CSP/同源校验、基本请求限流、连接上限、角色权限分离 |
| 部署 | 直接 Node.js；可选 systemd + Nginx HTTPS/SSE 反代 |

## 项目目录

```text
turtle-party/
├── package.json
├── README.md
├── README.en.md
├── public/
│   ├── index.html
│   ├── app.js                  # 浏览器交互、弱网重连和 SSE 状态同步
│   ├── style.css              # 共用/PC 端
│   └── mobile.css             # 移动端和低高度横屏
├── server/
│   ├── index.js               # HTTP、房间、SSE、认证、限流、托管
│   ├── engine.js              # 牌组规则和公平 AI
│   ├── store.js               # 本地原子房间快照与恢复
│   └── rate-limit.js          # 内存限流器
├── tests/
│   ├── api.test.js
│   ├── engine.test.js
│   ├── store.test.js
│   └── ui.test.js
├── deploy/
│   ├── chou-wugui.service     # systemd 服务模板
│   └── nginx-example.conf    # Nginx HTTPS/SSE 反代模板
└── docs/
    ├── 抽乌龟-游戏设计-v1.2.md
    ├── 更新说明-v0.2.md
    ├── 更新说明-v0.3.md
    └── 实体手机与公网验收清单.md
```

## 运行环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Node 监听地址，默认只接受本机反代 |
| `PORT` | `3000` | Node 监听端口 |
| `DATA_DIR` | 项目根目录 `data` | 私有快照目录，不可暴露在静态目录 |
| `TRUST_PROXY` | `0` | 经本机可信 Nginx 反代时设为 `1`，使用 `X-Real-IP` 获取访客地址 |
| `TURN_MS` | `30000` | 每次抽牌回合最长时间（毫秒） |
| `DISCONNECT_GRACE_MS` | `5000` | SSE 断开后进入托管的宽限时间 |
| `MAX_ROOMS` | `300` | 单进程最大内存房间数 |
| `MAX_STREAMS` | `300` | 单进程最大 SSE 客户端连接数 |

不使用 `.env` 解析器。生产环境请通过 systemd `Environment=` 或 shell 环境变量配置。

## Debian 13 + Nginx 部署参考

1. 使用 Node.js 20+，核对 `node --version` 和非 root 系统服务可访问的 Node 路径。
2. 建立专用系统用户 `wugui`、源码目录 `/opt/chou-wugui`，限制目录权限。
3. 参考 `deploy/chou-wugui.service` 创建服务，使 Node 只监听 `127.0.0.1:3000`，快照保存在 `/var/lib/chou-wugui/rooms.json`。
4. 在 Nginx/宝塔已有的 HTTPS 站点中添加反向代理；参考 `deploy/nginx-example.conf`。**SSE 必须关闭代理缓冲并设置足够长的读取超时。**
5. 开放 80/443；关闭外网对 3000 的直接访问；`nginx -t` 后重载并执行 `curl https://你的域名/api/health`。
6. 完成 `docs/实体手机与公网验收清单.md` 的实体设备、弱网和公网测试，再考虑正式开放。

查看进程日志：`journalctl -u chou-wugui -n 100 --no-pager`。

## 当前限制

- **不是已经验收的生产部署。** 尚未验证真实 iPhone Safari/Android Chrome、真实公网、多机并发及第三方安全审计。
- 单机 JSON 持久化只支持**一个 Node 进程**；禁止多个节点/进程共享一个快照文件，否则可能覆盖或损坏牌局。
- 已确认成功的真人操作在返回前持久化；后台 AI 事件使用约 70ms 写入合并窗口，系统异常断电时可能丢失最后极少量后台事件。
- v0.2 没有快照，升级后不能恢复已在旧版内存中进行的旧房间。
- 会话凭证存在浏览器 `localStorage` 以支持刷新恢复，务必使用 HTTPS 并避免注入未经审核的第三方脚本。
- HTTP 安全头与限流是基础防护，不能替代云端防火墙/WAF、备份和安全审计。

完整更新记录：`docs/更新说明-v0.3.md`。

## 参与开发 / Contributing

欢迎提交 Issue 和 Pull Request。提交前请执行 `npm test`。GitHub Actions 会在 Node.js 20 和 22 上验证。

本仓库暂未声明开源许可证；公开可见不代表授予第三方复制、修改或再分发的权利。更多信息请查阅 [English README](README.en.md)。
