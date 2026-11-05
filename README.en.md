# Turtle Party · Old Maid

**Multiplayer browser card game** · **v0.4.0** · [简体中文](README.md)

Play Old Maid with **2–6 players**, fair AI opponents, or friends in a shared room. Built with native HTML/CSS/JavaScript, Node.js, and SSE. **No Docker, database, or third-party npm dependencies.**

> **Validation:** Automated tests and desktop/mobile viewport browser checks are available. Real iOS/Android devices, network switching, and independent security/performance reviews remain pending. Live site: [cwg.duanap.cn](https://cwg.duanap.cn).

## Features

- **Quick play:** One human plus three AI opponents by default.
- **Friend rooms:** Join via a six-digit room code (including leading zeros) and add AI seats.
- **Classic rules:** Remove one card from a 52-card deck; discard matching ranks; the last player with one unmatched card loses.
- **Interaction:** Synchronized selection raises the target's card. Every drawn face is revealed to the table, moves into the actor's hand, then pairs are animated away. The game interface uses Chinese text and always-visible home rules.
- **Immersive table:** Entry, waiting and play share one scene, using supplied transparent PNG artwork. Mutable labels stay in HTML; each playing card remains a separate interactive element. Modal settings provide optional quiet sound and reduced motion.
- **Resilience:** SSE updates, reconnection, polling fallback, temporary autoplay, and private single-instance room snapshots.

## Run locally

Requires **Node.js 20+**. You do not need to run `npm install`.

```bash
npm start
# Open http://127.0.0.1:3000
npm test
```

The server binds to `127.0.0.1` by default. For testing on a **trusted LAN only**, use `HOST=0.0.0.0 PORT=3000 npm start`. For internet-facing access, use HTTPS through a reverse proxy; **do not expose port 3000 directly**.

## Documentation

The detailed documentation is organized into separate Markdown files (currently primarily in Chinese):

| Topic | File |
| --- | --- |
| [Documentation index](docs/文档索引.md) | All technical and gameplay documentation |
| [Game rules](docs/游戏规则.md) | Deck, turns, matching, winning and losing |
| [Card interaction and layout](docs/抽牌交互与界面.md) | Desktop and mobile controls |
| [AI strategy and fairness](docs/AI策略与信息公平.md) | Information boundaries and memory |
| [Lobby and rooms](docs/大厅与房间.md) | Multiplayer flow and permissions |
| [Architecture](docs/技术架构.md) | HTTP/SSE, server, persistence, config |
| [Deployment](docs/部署与运维.md) | Debian, systemd, Nginx, HTTPS |
| [Testing and acceptance](docs/测试与验收.md) | Automated tests and outstanding checks |
| [v0.4 changelog](docs/更新说明-v0.4.md) | Numeric rooms, public draw reveals, synchronized selection |
| [v0.3 changelog](docs/更新说明-v0.3.md) | Version details and limitations |

The earlier [v1.2 design document](docs/抽乌龟-游戏设计-v1.2.md) remains available for historical reference and is not the current implementation-status source.

## Development and limitations

Run `npm test` (35 tests) before submitting a pull request. CI checks Node.js 20 and 22. Optional `npm run test:browser` checks use a separately available Playwright installation, without adding a game runtime dependency; see the testing guide. Persistent room data is stored in a private JSON file and is safe for **one Node.js process only**. Do not commit `data/`. Browser sessions use `localStorage`; deploy behind HTTPS.

**License:** No open-source license is currently granted. A public GitHub repository does not automatically authorize reuse or redistribution.
