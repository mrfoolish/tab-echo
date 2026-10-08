# Tab Echo 关闭记录、回收站与完整页面实施计划

> **供执行 Agent 使用：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，逐项执行本计划。所有步骤使用复选框跟踪。

**目标：** 在不破坏现有关闭记录能力的前提下，实现可留空的保存规则、软删除回收站、可靠的常规/无痕捕获、分组精确搜索、紧凑 Popup 和完整管理页面。

**架构：** 纯函数模块负责设置、事件、搜索、回收站和迁移；Chrome 适配层负责分区存储、串行写入、快照、alarm 与消息协议；Popup 只承担前 10 条快速操作，完整页面承担分页、回收站和设置。共享设置与常规/无痕内容使用独立键，避免 split Worker 覆盖。

**技术栈：** Chrome Extension Manifest V3、原生 JavaScript、HTML/CSS、`chrome.storage.local/session`、`chrome.tabs/windows/alarms`、Node `node:test`。

---

## 文件职责

- `extension/lib/history-store.js`：纯数据模型、设置校验、历史清理、搜索匹配元数据、软删除与回收站恢复。
- `extension/lib/storage-repository.js`：存储键、迁移、按上下文读写、串行事务和有限重试。
- `extension/lib/close-tracker.js`：标签/窗口快照与关闭批次的纯状态转换。
- `extension/background.js`：Chrome 事件注册、Worker 初始化、alarm、页面复用和消息路由。
- `extension/popup.*`：最多 10 条的快速搜索、重新打开和当前显示批量软删除。
- `extension/dashboard.*`：完整历史、回收站、设置、分页和 URL 状态。
- `extension/tests/*.test.js`：纯逻辑、消息适配和静态 UI 契约测试。

### 任务 1：扩展设置模型，支持不限条数与不限期限

**文件：**
- 修改：`extension/lib/history-store.js`
- 修改：`extension/tests/history-store.test.js`

- [ ] **步骤 1：先写失败测试**

新增用例，断言默认值为 `maxRecords: 10000`、`maxAgeDays: null`、`trashMaxAgeDays: 3`、`settingsVersion: 2`；空字符串归一化为 `null`；`0`、负数和非数字返回字段错误，而不是退回默认值。

- [ ] **步骤 2：运行测试并确认按预期失败**

运行：`node --test extension/tests/history-store.test.js`

预期：默认值和空值语义断言失败，证明旧实现仍强制正整数与旧默认值。

- [ ] **步骤 3：实现设置解析与校验**

在纯逻辑模块中增加：

```js
const DEFAULT_SETTINGS = Object.freeze({
  maxRecords: 10000,
  maxAgeDays: null,
  trashMaxAgeDays: 3,
  pageSize: 50,
  language: 'en',
  theme: 'system',
  settingsVersion: 2,
});

function parseOptionalPositiveInteger(value, field) {
  if (value === '' || value === null || value === undefined) {
    return { value: null, error: null };
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return { value: null, error: `${field} must be a positive integer or blank.` };
  }
  return { value: number, error: null };
}
```

导出 `validateSettingsInput()`；`normalizeSettings()` 只处理已验证数据和旧数据迁移，不再把非法用户输入静默变成默认值。

- [ ] **步骤 4：验证测试变绿**

运行：`node --test extension/tests/history-store.test.js`

预期：全部通过。

### 任务 2：实现历史清理、回收站和容量规则的纯逻辑

**文件：**
- 修改：`extension/lib/history-store.js`
- 修改：`extension/tests/history-store.test.js`

- [ ] **步骤 1：为不限语义和清理顺序写失败测试**

覆盖：`null` 条数不裁剪、`null` 天数不按年龄清理、有限配置先按 `restoredAt ?? closedAt` 清理年龄再裁剪最旧事件、Group 只计一条。

- [ ] **步骤 2：运行并确认失败**

运行：`node --test extension/tests/history-store.test.js`

预期：旧的数值乘法或默认回退导致不限语义测试失败。

- [ ] **步骤 3：实现纯函数**

实现并导出：

```js
pruneHistoryEntries(events, settings, now)
pruneTrashEntries(entries, settings, now)
countTabs(events)
previewRetentionImpact(events, trash, nextSettings, now)
moveEventsToTrash(history, trash, eventIds, deletedAt)
restoreTrashEntries(history, trash, trashIds, settings, restoredAt)
permanentlyDeleteTrashEntries(trash, trashIds)
```

`restoreTrashEntries` 先计算整批恢复后的事件数；超过有限 `maxRecords` 时返回 `{ ok: false, requiredSlots }` 且不修改输入。

- [ ] **步骤 4：覆盖软删除和原子恢复测试**

测试单条、批量、全量软删除均保留完整 Group 并写入 `deletedAt`；回收站不去重；恢复保留 `closedAt`、写入 `restoredAt`；容量不足时历史与回收站均不变化。

- [ ] **步骤 5：运行全部纯逻辑测试**

运行：`node --test extension/tests/history-store.test.js`

预期：全部通过。

### 任务 3：实现 Group 精确搜索模型

**文件：**
- 修改：`extension/lib/history-store.js`
- 修改：`extension/tests/history-store.test.js`

- [ ] **步骤 1：写 Group 搜索失败测试**

期望 `searchEvents()` 返回：

```js
{
  event,
  matchedTabs,
  matchedTabCount,
  totalTabCount,
  matchRanges: { [tabId]: { title: [], url: [] } },
}
```

验证一个子标签命中时只列出该子项，但 `event.tabs` 仍完整；统计同时返回事件数和标签页数；Trash 搜索不做 URL 去重。

- [ ] **步骤 2：运行并确认旧返回结构导致失败**

运行：`node --test extension/tests/history-store.test.js`

- [ ] **步骤 3：实现查询模型和高亮区间**

新增 `buildSearchResults(events, query, { deduplicateSingles })` 和 `findMatchRanges(text, query)`。空查询返回完整展示项；非空查询保留不可变事件并附加匹配元数据。

- [ ] **步骤 4：运行测试**

运行：`node --test extension/tests/history-store.test.js`

预期：全部通过。

### 任务 4：建立分区存储仓库与一次性迁移

**文件：**
- 新建：`extension/lib/storage-repository.js`
- 新建：`extension/tests/storage-repository.test.js`
- 修改：`extension/background.js`

- [ ] **步骤 1：使用内存 storage fake 写失败测试**

覆盖独立键 `tabEcho:settings:v2`、`tabEcho:history:normal:v2`、`tabEcho:history:incognito:v2`、`tabEcho:trash:normal:v2`、`tabEcho:trash:incognito:v2`；验证 normal 写入不覆盖 incognito。

- [ ] **步骤 2：运行并确认模块不存在**

运行：`node --test extension/tests/storage-repository.test.js`

- [ ] **步骤 3：实现 repository 与模式内串行事务**

模块采用 UMD 导出，提供：

```js
createStorageRepository(storageArea, { now, retryLimit })
repository.getSettings()
repository.saveSettings(input)
repository.readHistory(mode)
repository.readTrash(mode)
repository.updateContext(mode, mutator)
repository.migrateLegacyState()
```

`updateContext` 通过 mode 对应的 Promise 链串行化，并在每次 mutation 前重新读取最新键。写入失败不发布内存状态，最多重试固定次数后抛出具体错误。

- [ ] **步骤 4：写迁移失败测试**

覆盖旧 `tabEchoState`：旧默认 `65536/30` 迁移到 `10000/null`；自定义值保持；损坏事件计数；新键写入和校验完成前旧键不删除；中断可重试；迁移版本阻止重复迁移。

- [ ] **步骤 5：实现两阶段迁移并运行测试**

运行：`node --test extension/tests/storage-repository.test.js`

预期：全部通过。

### 任务 5：建立可靠的关闭快照和窗口分组

**文件：**
- 新建：`extension/lib/close-tracker.js`
- 新建：`extension/tests/close-tracker.test.js`
- 修改：`extension/background.js`

- [ ] **步骤 1：写状态转换失败测试**

覆盖：Worker 初始化补水、标签创建/更新/移动、普通快速关闭批次、整窗关闭使用最后持久快照、整窗关闭不被 `tabs.onRemoved` 重复记录、最终无痕窗口关闭不依赖 450ms 内存 timer。

- [ ] **步骤 2：运行并确认模块不存在**

运行：`node --test extension/tests/close-tracker.test.js`

- [ ] **步骤 3：实现 close tracker**

以纯函数维护 `tabSnapshotsById`、`windowSnapshotsById` 和持久化 `pendingBatches`。`windows.onRemoved` 直接消费对应窗口快照；普通 `tabs.onRemoved` 将待处理批次先写入 session storage，再安排短延迟 flush。初始化 Promise 在模块加载时开始，所有关闭处理先等待它。

- [ ] **步骤 4：接入后台并避免重复事件**

在 `background.js` 注册 `windows.onRemoved`，以已消费窗口集合忽略同次关闭产生的 tab removal；所有历史写入经 repository 的模式队列执行。

- [ ] **步骤 5：运行关闭跟踪与历史测试**

运行：`node --test extension/tests/close-tracker.test.js extension/tests/history-store.test.js`

预期：全部通过。

### 任务 6：接入混合清理、alarm 和消息协议

**文件：**
- 修改：`extension/manifest.json`
- 修改：`extension/background.js`
- 新建：`extension/tests/background-contract.test.js`

- [ ] **步骤 1：写静态和适配层失败测试**

断言 manifest 包含 `alarms` 权限；后台注册安装、启动和 alarm；`get-history`、`get-trash` 在返回数据前清理；自动清理不写入 Trash。

- [ ] **步骤 2：运行并确认失败**

运行：`node --test extension/tests/background-contract.test.js`

- [ ] **步骤 3：实现每日 alarm 与上下文内清理**

安装和启动时使用固定 alarm 名创建每日任务；alarm 回调只读取当前 split 上下文的数据键。读取消息先执行清理，仅在数据变化时写回。

- [ ] **步骤 4：实现完整消息协议**

提供 `get-history`、`get-trash`、`move-to-trash`、`restore-trash`、`restore-trash-results`、`permanently-delete-trash`、`empty-trash`、`preview-settings-impact`、`save-settings`、`reopen-event`、`reopen-tab`、`open-dashboard`。所有批量动作接收明确事件 ID 集合或 `all` 标志，禁止依赖 UI 页码的隐式范围。

- [ ] **步骤 5：运行后台契约和全部数据测试**

运行：`node --test extension/tests/background-contract.test.js extension/tests/storage-repository.test.js extension/tests/close-tracker.test.js extension/tests/history-store.test.js`

### 任务 7：实现完整页面骨架、路由与分页

**文件：**
- 新建：`extension/dashboard.html`
- 新建：`extension/dashboard.css`
- 新建：`extension/dashboard.js`
- 新建：`extension/tests/dashboard-ui.test.js`
- 修改：`extension/manifest.json`

- [ ] **步骤 1：写完整页面静态契约失败测试**

断言存在 `Closed tabs / Trash / Settings` 对应的本地化导航、搜索、分页 25/50/100、状态区、设置表单和正确脚本引用；无内联事件处理器。

- [ ] **步骤 2：运行并确认页面不存在**

运行：`node --test extension/tests/dashboard-ui.test.js`

- [ ] **步骤 3：实现页面结构与 URL 状态**

解析 `?view=history|trash|settings&q=`；无效 view 回退 history；搜索和导航变化时页码归 1；只把最后 view 保存到共享设置或 session 状态，不保存 query/page。

- [ ] **步骤 4：实现历史列表**

复用纯搜索模型渲染 25/50/100 分页、Group 自动展开、`mark` 高亮、子标签 `重新打开`、完整分组 `全部重新打开（N）`、单条软删除、全部搜索结果软删除和清空全部底层事件。确认文案同时包含事件数和标签页数。

- [ ] **步骤 5：运行静态 UI 测试和语法检查**

运行：`node --check extension/dashboard.js && node --test extension/tests/dashboard-ui.test.js`

### 任务 8：实现完整页面回收站与设置

**文件：**
- 修改：`extension/dashboard.html`
- 修改：`extension/dashboard.css`
- 修改：`extension/dashboard.js`
- 修改：`extension/tests/dashboard-ui.test.js`

- [ ] **步骤 1：写回收站交互失败测试**

锁定搜索、删除时间排序、Group 匹配、恢复单条、按 query 恢复全部、单条永久删除更多菜单、清空回收站二次确认、空/加载/错误状态和模式隔离文案。

- [ ] **步骤 2：实现回收站视图**

回收站不去重；Group 搜索只显示命中子项但恢复保持完整事件；恢复全部后返回历史视图；容量不足显示缺少槽位且不改变两侧数据。

- [ ] **步骤 3：写设置验证与影响预览失败测试**

覆盖空值帮助文本、非法输入行内错误、缩小限制的影响预览、确认取消不保存、确认后保存以及另一上下文延后应用提示。

- [ ] **步骤 4：实现设置视图**

输入值保持字符串直到验证；显式保存；按 Q26 双语规范渲染帮助、摘要和错误；不申请 `unlimitedStorage`。

- [ ] **步骤 5：运行完整页面测试**

运行：`node --check extension/dashboard.js && node --test extension/tests/dashboard-ui.test.js`

### 任务 9：收敛 Popup 为最多 10 条的快速入口

**文件：**
- 修改：`extension/popup.html`
- 修改：`extension/popup.css`
- 修改：`extension/popup.js`
- 修改：`extension/tests/popup-ui.test.js`

- [ ] **步骤 1：更新 Popup 失败测试**

断言无分页和内嵌设置表单；最多渲染 10 条；存在设置跳转、带数量的回收站入口和 `查看全部 N 条结果`；无清空全部按钮；双语使用 `重新打开`、`移至回收站`、`常规窗口 · 已关闭标签页`。

- [ ] **步骤 2：运行并确认旧 UI 不满足新契约**

运行：`node --test extension/tests/popup-ui.test.js`

- [ ] **步骤 3：实现 Popup 收敛**

将当前 400×600 改造保留为视觉基础；记录行压缩至 52–56px；移除保存规则摘要、分页、内嵌设置和清空全部；搜索请求返回总结果数但只渲染 10 条。Popup 当前显示批量删除始终传显式 ID 集合。

- [ ] **步骤 4：实现页面复用跳转**

`open-dashboard` 查找当前上下文已存在的 `dashboard.html` 标签，存在则更新 URL 并聚焦，否则创建；常规和无痕互不复用。

- [ ] **步骤 5：运行 Popup 测试与语法检查**

运行：`node --check extension/popup.js && node --test extension/tests/popup-ui.test.js`

### 任务 10：双语文案、文档与全量验收

**文件：**
- 修改：`README.md`
- 修改：`README.zh.md`
- 修改：`extension/popup.js`
- 修改：`extension/dashboard.js`
- 修改：`extension/tests/popup-ui.test.js`
- 修改：`extension/tests/dashboard-ui.test.js`

- [ ] **步骤 1：执行可见文案清单审计**

对照 `proposal.md` 第 12 节，删除 `Normal history`、`普通历史`、`Restore` 表示打开网页、`current mode`、`extension request failed` 等旧用语。用户中文使用“网址”，英文操作区分 `Reopen` 与 `Restore entry`。

- [ ] **步骤 2：更新 README 为已交付行为**

仅在全部代码和测试落地后更新双语 README：说明 Popup/完整页面职责、默认 `10000 / 不限天数`、回收站 3 天、无痕开启方式和 `alarms` 权限用途，并更新项目结构和测试命令。

- [ ] **步骤 3：运行完整自动验证**

运行：

```bash
node --check extension/lib/history-store.js
node --check extension/lib/storage-repository.js
node --check extension/lib/close-tracker.js
node --check extension/background.js
node --check extension/popup.js
node --check extension/dashboard.js
node --test extension/tests/*.test.js
git diff --check
```

预期：所有命令退出码为 0，无失败测试和空白错误。

- [ ] **步骤 4：执行 Chrome 人工验收清单**

加载 `extension/` 后逐项验证：常规单标签关闭、整窗关闭、Worker 休眠后关闭、最终无痕窗口关闭、普通/无痕隔离、Popup 10 条限制、搜索词跳转、Group 子项打开、软删除和回收站恢复、自动/手动永久删除、容量拒绝、设置空值与错误值、旧数据迁移、浅/深/系统主题、键盘焦点和长中英文。记录 Chrome 版本与失败截图。

## 实施顺序与检查点

1. 完成任务 1–3 后，数据语义稳定，可独立审查。
2. 完成任务 4–6 后，迁移、无痕捕获和后台协议稳定，可在 Chrome 做第一次真实数据验收。
3. 完成任务 7–8 后，完整页面和回收站可端到端验收。
4. 完成任务 9–10 后，Popup、双语文档和全量验收收口。

每个检查点都必须先运行该阶段全部测试；本仓库目前没有 Git commit，除非用户另行明确要求，不在计划执行中自动提交。
