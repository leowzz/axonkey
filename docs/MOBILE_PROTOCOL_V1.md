# Axonkey Mobile Protocol v1 (`axonkey.mobile/1`)

状态：`accepted`（v1 实施规范）

本文档定义 Axonkey 桌面端（`src-tauri/src/mobile_host`）与 Axonkey Mobile 移动端之间的局域网安全传输、配对鉴权、输入租约、撤销屏障与双向 Deck 同步协议。

> 与 `docs/DEVICE_INPUT_SOURCES.md`（`axonkey.device/2` 草案）的关系：
> 本协议面向手机动态可编程触控面板与触控板，独立演进且不要求改写现有 15 款 `axonkey.device/1` 物理设备描述符。

## 1. 传输与安全

- **传输层**：TLS WebSocket（`wss://<lan-ip>:<port>/ws`），WebSocket 子协议固定为 `axonkey.mobile/1`。
- **信任锚**：桌面首次启用时在应用数据目录生成安装级 ECDSA P-256 私有 CA 与叶证书（SAN 含 `<hostId>.axonkey.local` 与当前局域网 IP）。
- **扫码配对**：桌面生成 120 秒有效的一次性 256-bit `pairToken`，连同 `hostId`、`addrs`、`caCertDerB64` 编码为二维码。
  - 手机仅将该 CA 存入该 `hostId` 专属的应用内信任库，不修改系统根证书，不接受任意证书。
  - 建立验证通过的 WSS 后发送 `pair.request`，桌面原子消费 `pairToken` 并签发 `(peerId, peerToken)`，桌面仅持久化 `peerToken` 的 SHA-256 哈希。
- **重连鉴权**：后续连接直接通过 WSS 发送 `client.auth(peerId, peerToken)`。TLS 负责保密性、完整性与服务器认证。

## 2. 会话状态机与租约（Lease）

```text
Disconnected -> Authenticating -> Synchronizing -> Active -> Revoking -> Closed
```

- 每个活跃会话由 `(sessionId, inputEpoch)` 唯一标识；客户端上行控制消息必须携带单调递增 `seq: u32` 与生成事件时持有的 `leaseId`。
- 服务端每 `250ms` 下发一次 `server.tick(leaseId)`，每个 `leaseId` 自签发起有效 `750ms`。
- 超过 `750ms` 未收到有效 `client.alive` 或控制事件携带过期 `leaseId` 时，服务端拒绝执行并触发串行撤销屏障；连续 `4500ms` 无活动则关闭连接。
- **撤销屏障（Serial Revoke Barrier）**：断连、超期、手机切后台 `input.cancel`、新连接接管或动作绑定变更时，串行作废旧 `inputEpoch` -> 通过共享 `OwnershipLedger` 仅释放该 `sessionId` 持有的键鼠按键 -> 清空亚像素余量 -> 完成后方可激活新会话。

## 3. 消息契约

### 3.1 Client -> Server

- `pair.request`: `{ pairToken, deviceName }`
- `client.auth`: `{ peerId, peerToken, deviceName }`
- `client.alive`: `{ sessionId, leaseId }`
- `tile.activate`: `{ sessionId, inputEpoch, seq, leaseId, requestId, tileId, gesture: "tap" | "double" | "long" }`
- `tile.hold.begin` / `tile.hold.end`: `{ sessionId, inputEpoch, seq, leaseId, requestId, tileId, pressId }`
- `pointer.motion`: `{ sessionId, inputEpoch, seq, leaseId, dx, dy }`（相对逻辑单位，手机 60Hz 合并，服务端保留小数余量并调用纯相对 `MOUSEEVENTF_MOVE`）
- `pointer.scroll`: `{ sessionId, inputEpoch, seq, leaseId, x, y }`（服务端保留小数余量）
- `pointer.button`: `{ sessionId, inputEpoch, seq, leaseId, requestId, button: "left" | "right" | "middle", phase: "down" | "up", pressId }`
- `text.commit`: `{ sessionId, inputEpoch, seq, leaseId, requestId, text, mode: "paste" | "type", submit, contextRevision }`
- `deck.update`: `{ sessionId, requestId, baseRevision, layoutPatch }`
- `input.cancel`: `{ sessionId, inputEpoch, reason }`

### 3.2 Server -> Client

- `pair.result`: `{ ok, peerId?, peerToken?, error? }`
- `server.ready`: `{ sessionId, inputEpoch, leaseId, leaseTtlMs, tickIntervalMs, hostId, hostName, capabilities, deckSnapshot, deckRevision, context, contextRevision }`
- `server.tick`: `{ sessionId, inputEpoch, leaseId, leaseTtlMs }`
- `deck.snapshot`: `{ deckSnapshot, deckRevision, inputEpoch }`
- `context.changed`: `{ context, contextRevision }`
- `deck.update.result`: `{ requestId, ok, conflict?, deckRevision, deckSnapshot?, error? }`
- `command.result`: `{ requestId, ok, code?, message? }`
- `session.revoked`: `{ sessionId, reason }`
- `error`: `{ code, message }`
