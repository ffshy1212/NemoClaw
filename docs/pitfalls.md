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

### 修復

在檔案頂部加入全域設定：

```js
require("net").setDefaultAutoSelectFamily(true);
```

> 注意：`autoSelectFamily` 無法直接加在 `https.request` options 中，TypeScript 型別定義不包含此欄位，會出現 `No overload matches this call`。

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

## 總結

| # | 問題 | 根本原因 | 是否修復 |
|---|------|---------|---------|
| 1 | 啟動 ETIMEDOUT | `autoSelectFamily: false` | ✅ 已修 |
| 2 | 無法暫停 sandbox | openshell CLI 設計限制 | ❌ CLI 本身問題 |
| 3 | bridge 無法自動停止 | 無 sandbox 暫停狀態可偵測 | ⚠️ 部分修復（delete 可偵測） |
| 4 | `nemoclaw start` 不重啟 bridge | PID 還活著就跳過 | ⚠️ 需先手動 stop |
| 5 | `nemoclaw stop` 找不到 bridge | stop 沒傳 sandbox name，PID 路徑錯誤 | ✅ 已修 |
