# NemoClaw 踩坑紀錄

## 1. telegram-bridge.js 啟動時 ETIMEDOUT

### 症狀

```text
AggregateError [ETIMEDOUT]
  - connect ETIMEDOUT 149.154.166.110:443   (IPv4)
  - connect EHOSTUNREACH 2001:67c:4e8:f004::9:443  (IPv6)
```

### 原因

原始碼設定了 `autoSelectFamily: false`，停用了 Happy Eyeballs 演算法。Node.js v18+ 會同時嘗試 IPv4 和 IPv6，IPv6 無路由時不會正確 fallback，導致兩個錯誤被包成 `AggregateError` 一起丟出。

### 嘗試過無效的修法

- `require("net").setDefaultAutoSelectFamily(true)`：只影響 `net.createConnection`，對 `https.request` 無效
- `autoSelectFamily: true` 加在 `https.request` options：TypeScript 型別定義不包含此欄位，出現 `No overload matches this call`；即使用 `/** @type {any} */` 繞過型別，runtime 上 Node.js 對「DNS 有 IPv6 但網路不通」的環境仍無法正確 fallback

### 修復

在 `https.request` options 強制指定 IPv4，並用 `/** @type {any} */` 繞過型別警告：

```js
const req = https.request(
  /** @type {any} */ ({
    hostname: "api.telegram.org",
    path: `/bot${TOKEN}/${method}`,
    method: "POST",
    family: 4, // force IPv4: DNS returns IPv6 but no route exists on this network
    headers: { ... },
  }),
```

### 補充

此問題為特定網路環境造成（DNS 回傳 IPv6 位址但無路由），多數使用者不會遇到。若未來網路支援 IPv6，可移除 `family: 4`。

---

## 2. openshell 沒有 `sandbox stop` 指令

### 症狀

想停止 sandbox 但找不到對應指令。

### 現有指令對照

| 指令 | 實際效果 |
|------|---------|
| `openshell forward stop` | 只停止 port forward（網路隧道），sandbox 本體不受影響 |
| `openshell sandbox delete <name>` | 真正刪除並停止 sandbox |

### 結論

openshell CLI 沒有「暫停」sandbox 的機制，只能 delete。`sandbox list` 顯示 `Ready` = 仍在運行中。

---

## 3. telegram-bridge 在 sandbox 關閉後仍繼續運行

### 症狀

關閉 sandbox（或以為關閉）後，telegram-bridge 仍在背景運行，agent 仍能回應訊息。

### 原因

- bridge 用 `setTimeout` 無限 poll，沒有綁定 sandbox 生命週期
- `forward stop` 不會停止 sandbox，所以 SSH 連線依然有效

### 部分修復

加入 health check，連續 3 次（約 90 秒）`ssh-config` 失敗才退出：

```js
let sandboxFailCount = 0;
setInterval(() => {
  if (!isSandboxAlive()) {
    sandboxFailCount++;
    if (sandboxFailCount >= 3) process.exit(0);
  } else {
    sandboxFailCount = 0;
  }
}, 30_000);
```

### 限制

health check 只在 sandbox 被 **delete** 時才能偵測到。只要 sandbox 仍是 Ready 狀態，bridge 永遠不會自動退出。

### 建議

- 前景執行 bridge，用 Ctrl+C 手動停止
- 或使用 PM2 等 process manager 管理生命週期

---

## 4. `nemoclaw start` 不會重啟已在背景運行的 bridge

### 症狀

執行 `nemoclaw start my-assistant` 後 log 沒有更新，bridge 沒有重啟。

### 原因

`start-services.sh` 在啟動前檢查 PID 是否還活著，若 process 仍在運行就直接略過，不重啟。

### 解法

先 stop 再 start：

```bash
bash ~/.nemoclaw/source/scripts/start-services.sh --sandbox my-assistant --stop
nemoclaw start my-assistant
```

---

## 5. `nemoclaw stop` 找不到正在運行的 telegram-bridge

### 症狀

```text
[services] telegram-bridge was not running
```

但 bridge 實際上仍在背景運行。

### 原因

`nemoclaw stop` 呼叫 `start-services.sh --stop` 時沒有傳入 sandbox name，預設使用 `default`，去 `/tmp/nemoclaw-services-default/` 找 PID file，但實際 PID file 在 `/tmp/nemoclaw-services-my-assistant/`。

原始碼問題：

```js
// start() 有帶 SANDBOX_NAME
run(`${sandboxEnv} bash "${SCRIPTS}/start-services.sh"`);

// stop() 沒帶，預設為 "default"
run(`bash "${SCRIPTS}/start-services.sh" --stop`);
```

### 修復

`stop()` 補上與 `start()` 相同的 sandbox name 邏輯（已修復於 `bin/nemoclaw.js`）。

### 暫時解法（修復前）

```bash
bash ~/.nemoclaw/source/scripts/start-services.sh --sandbox my-assistant --stop
```

---

## 6. CLI 兩層設計造成職責混淆

### 架構說明

NemoClaw + OpenShell 分為兩層：

| 層 | 工具 | 負責 |
|----|------|------|
| 基礎設施層 | `openshell` | sandbox 生命週期、網路、port forward、egress 審批 |
| 應用層 | `nemoclaw` | AI agent 服務（telegram bridge、cloudflared tunnel）|

### 混淆點

- `openshell sandbox list` vs `openshell forward list` — 兩個 list，語意完全不同
- `openshell forward stop` — 只停隧道，不停 sandbox，名稱容易誤導
- `openshell sandbox stop` — 不存在，只有 `delete`
- `nemoclaw start` / `nemoclaw stop` — 管 agent 服務，但內部偷偷呼叫 `openshell forward start`，讓使用者誤以為一個指令搞定所有事

### 正確的操作心智模型

```text
啟動：
  1. openshell sandbox create    → 建沙盒（基礎設施）
  2. nemoclaw start              → 啟動 agent 服務（應用層）

停止：
  1. nemoclaw stop               → 停 agent 服務（應用層）
  2. openshell sandbox delete    → 刪沙盒（基礎設施）
```

---

## 7. `nemoclaw start` 不接受 sandbox 名稱參數

### 症狀

執行 `nemoclaw start my-assistant` 看起來像是指定了 sandbox，實際上參數被忽略。

### 原因

`start()` 內部是從 registry（本地紀錄）自動抓預設 sandbox，不接受 CLI 參數：

```js
async function start() {
  const { defaultSandbox } = registry.listSandboxes(); // 忽略使用者傳入的參數
  ...
}
```

### 影響

- 多個 sandbox 並存時，不知道會啟動哪一個的服務
- Help 文字完全沒提及 sandbox，誤導使用者以為可以指定

### 建議的 help 文字

```text
nemoclaw start                   Start auxiliary services for the default registered sandbox
nemoclaw start <sandbox>         Start auxiliary services for a specific sandbox
```

---

## 8. `openshell sandbox delete` 不會同步清除 nemoclaw registry

### 症狀

刪除 sandbox 後，`nemoclaw status` 仍顯示已刪除的 sandbox，且舊 sandbox 仍是 default（`*`）：

```text
Sandboxes:
    dada
    my-assistant *

  ● telegram-bridge  (stopped)
  ● cloudflared  (stopped)
```

`nemoclaw start` 因此嘗試連接不存在的 sandbox，bridge 無法啟動。

### 原因

`openshell` 和 `nemoclaw` 各自維護獨立的狀態：

- `openshell sandbox delete` → 只刪 openshell 這邊的 sandbox
- `~/.nemoclaw/sandboxes.json` → nemoclaw 的本地 registry，完全不受影響

### 手動修復

直接編輯 `~/.nemoclaw/sandboxes.json`，移除已刪除的 sandbox 並更新 `defaultSandbox`：

```json
{
  "sandboxes": {
    "dada": { ... }
  },
  "defaultSandbox": "dada"
}
```

### 正確的刪除流程

```bash
nemoclaw stop                          # 停 agent 服務
nemoclaw <name> destroy                # 透過 nemoclaw 刪（會同步清 registry）
# 不要直接用 openshell sandbox delete
```

---

## 總結

| # | 問題 | 根本原因 | 是否修復 |
|---|------|---------|---------|
| 1 | 啟動 ETIMEDOUT | `autoSelectFamily: false` + 網路環境無 IPv6 路由 | ✅ 已修（`family: 4`）|
| 2 | 無法暫停 sandbox | openshell CLI 設計限制，只有 delete | ❌ CLI 本身問題 |
| 3 | bridge 無法自動停止 | 無 sandbox 暫停狀態可偵測 | ⚠️ 部分修復（delete 可偵測） |
| 4 | `nemoclaw start` 不重啟 bridge | PID 還活著就跳過 | ⚠️ 需先手動 stop |
| 5 | `nemoclaw stop` 找不到 bridge | stop 沒傳 sandbox name，PID 路徑錯誤 | ✅ 已修 |
| 6 | CLI 兩層職責混淆 | nemoclaw / openshell 邊界不清晰 | ❌ 設計問題 |
| 7 | `nemoclaw start` 忽略 sandbox 參數 | 內部從 registry 抓預設，不接受 CLI 輸入 | ❌ 設計問題 |
| 8 | `openshell sandbox delete` 不清 registry | 兩個工具各自維護獨立狀態 | ⚠️ 需手動修 `~/.nemoclaw/sandboxes.json` |
