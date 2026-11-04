# Turtle Party · Old Maid

**Version 0.3.0** | [简体中文](README.md)

Turtle Party is a lightweight browser-based **Old Maid (抽乌龟)** card game for 2–6 players. Play against fair AI opponents or create a room and invite friends. Built with native HTML, CSS, JavaScript and Node.js: **no database, Docker, or third-party npm dependencies**.

## Features

- **Quick match:** One human and three AI players by default.
- **Friend rooms:** Six-digit room codes, 2–6 players and optional AI fill-in seats.
- **Classic rules:** Remove one card from a 52-card deck; discard rank-matching pairs. The last player holding an unmatched card loses.
- **Card interaction:** Select and confirm a draw (tap directly if the target has one card), drag to reorder cards, or shuffle their positions.
- **Fair AI:** Decisions use the AI's own cards, legitimately observed information and public discards, never hidden opponent hands or the removed card.
- **Connection recovery:** SSE streams, reconnect retries, polling fallback, temporary AI takeover and seat recovery after reconnection.
- **Single-server snapshots:** In-memory rooms with atomic local JSON backups.

## Quick start

Requires **Node.js 20+**. No `npm install` is necessary.

```bash
npm start
# Open http://127.0.0.1:3000
npm test
```

For testing on a **trusted LAN only**, run `HOST=0.0.0.0 PORT=3000 npm start`. Never expose port 3000 directly to the public internet; use HTTPS via a reverse proxy.

## Technical architecture

| Component | Implementation |
| --- | --- |
| Browser | Native HTML/CSS/JS with separate mobile CSS |
| Backend | Native Node.js HTTP server |
| Multiplayer | JSON action API + SSE for game state |
| Game rules / AI | Server-authoritative state and information-limited AI |
| Persistence | In-memory `Map` and private atomic `data/rooms.json` snapshot |
| Authentication | Random bearer token; SHA-256 hash stored server-side |
| Deployment | Optional systemd service and Nginx HTTPS proxy |
| CI | GitHub Actions on Node.js 20 and 22 |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server binding |
| `PORT` | `3000` | Port |
| `DATA_DIR` | Project `data` directory | Private room snapshots |
| `TRUST_PROXY` | `0` | Use `1` only behind trusted local Nginx |
| `TURN_MS` | `30000` | Draw deadline in milliseconds |
| `DISCONNECT_GRACE_MS` | `5000` | AI takeover grace period |
| `MAX_ROOMS` | `300` | In-memory room limit |
| `MAX_STREAMS` | `300` | Simultaneous SSE stream limit |

## Deployment and security limitations

This is a **deployment candidate, not a certified production service**. Testing on real iOS/Android devices, public-network testing, concurrency testing and independent security review remain to be completed.

- Run **one** Node.js server process against a given snapshot; multiple processes sharing `data/rooms.json` risk corrupting state.
- Never commit or publicly serve the private `data/` directory.
- Browser session tokens are stored in `localStorage` for refresh/reconnect. Use HTTPS and avoid untrusted third-party scripts.
- The Nginx/systemd templates live in [`deploy/`](deploy/). See the [Chinese README](README.md), [v0.3 update notes](docs/更新说明-v0.3.md), and [real-device/public deployment checklist](docs/实体手机与公网验收清单.md).

## Contributing and licensing

Issues and pull requests are welcome; run `npm test` before submitting changes.

**No open-source license has been granted at this time.** A public repository does not automatically permit reuse or redistribution.
