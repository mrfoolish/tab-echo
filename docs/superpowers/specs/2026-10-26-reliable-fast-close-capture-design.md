# Tab Echo 快速关闭可靠捕获设计

## 背景

Tab Echo 偶发缺少已经关闭的标签页记录，而同一页面仍可在 Chrome 浏览历史中找到。诊断确认关闭事件没有进入 Tab Echo 的 durable outbox，并非 IndexedDB、保留规则或列表展示丢失。

存在两条可重复的快照缺失路径：

- Chrome 在新标签导航尚未提交时通过 `pendingUrl` 暴露目标地址，`tab.url` 仍为空。Tab Echo 只读取 `tab.url`，快速关闭会因缺少快照而被忽略。
- Chrome 预渲染或 Instant 切换可通过 `tabs.onReplaced` 用新 tab ID 替换旧 ID。Tab Echo 未监听该事件，关闭新 ID 时找不到旧快照。

## 目标

- 新标签只有 HTTP(S) `pendingUrl` 时也建立可恢复快照。
- 已有有效 `tab.url` 时继续以当前已提交页面为准，不让未提交导航覆盖它。
- tab ID 被 Chrome 替换后，将旧快照原位迁移到新 ID。
- 普通关闭继续即时进入 durable outbox，并沿用现有持久化、排除域名和保留规则。
- 不增加 Manifest 权限。

## 非目标

- 不从 Chrome 浏览历史或 Sessions API 回填过去已经丢失的记录。
- 不记录 `chrome://`、`file://` 或其他非 HTTP(S) 地址。
- 不改变整窗关闭生成 Group 的行为。
- 不改变 IndexedDB、无痕存储、搜索、分页或列表展示逻辑。

## 方案选择

### 采用：tracker 快照补全 + ID 迁移

`snapshotTab()` 按以下顺序选择地址：

1. `tab.url` 是 HTTP(S) 时使用 `tab.url`；
2. 否则 `tab.pendingUrl` 是 HTTP(S) 时使用 `tab.pendingUrl`；
3. 两者都不可记录时保持现有拒绝行为。

这保留了已有页面正在导航时的当前页面语义，同时覆盖新标签只有 pending URL 的窗口。

Close tracker 新增 `replaceTabId(addedTabId, removedTabId)`：

- 旧 ID 没有快照时安全忽略；
- 将旧快照的 `id` 改为新 ID；
- 在所属窗口的有序 `tabIds` 中原位替换 ID；
- 保留 URL、标题、位置、窗口和 mode；
- 后续 `onUpdated` 可继续用新 ID 更新最终元数据。

Background 注册 `chrome.tabs.onReplaced`，在现有 tracker 串行队列中迁移 ID、持久化 tracker 状态，并重试已有 outbox。

### 不采用：关闭后查询 Chrome History 或 Sessions

该方案需要新增权限，也无法可靠重建 Tab Echo 的窗口、顺序和真实关闭事件语义。Chrome 浏览历史表示访问记录，不等同于关闭事件。

### 不采用：引入 `webNavigation`

监听所有导航会增加权限、事件合并和 frame 过滤复杂度。本次缺失可在现有 tabs 生命周期模型内解决。

## 数据流

### 快速关闭

1. `tabs.onCreated` 收到 `url` 为空、`pendingUrl` 为目标 HTTP(S) 地址的 tab。
2. Tracker 使用 `pendingUrl` 建立 tab/window 快照并持久化。
3. `tabs.onRemoved` 使用该快照生成 single event。
4. 事件先进入 durable outbox，再提交历史仓储并 ack。

### 预渲染替换

1. Tracker 已保存旧 tab ID 的快照。
2. Chrome 触发 `tabs.onReplaced(addedTabId, removedTabId)`。
3. Tracker 将旧快照和窗口顺序中的 ID 替换为新 ID并持久化。
4. 新 ID 被关闭时可正常生成关闭事件。

## 错误与边界处理

- `pendingUrl` 非 HTTP(S) 时不建立快照。
- `onReplaced` 找不到旧快照时不创建猜测数据。
- 新旧 ID 相同或无效时安全忽略。
- ID 迁移走现有 `trackerQueue`，不得与 create/update/remove 并发修改 tracker。
- 存储失败继续使用现有 durable outbox、storage health 和下一事件重试机制。

## 测试

- Tracker：只有 `pendingUrl` 的 tab 可以生成 ordinary-close event。
- Tracker：已有有效 `url` 时不被不同的 `pendingUrl` 覆盖。
- Tracker：`replaceTabId` 保留快照内容、窗口顺序和位置。
- Background：`onCreated(pendingUrl) -> onRemoved` 后立即查询得到 1 条记录。
- Background：`onUpdated(status=loading, pendingUrl) -> onRemoved` 后得到 1 条记录。
- Background：`onReplaced(old -> new) -> onRemoved(new)` 后得到 1 条记录。
- 保留非 HTTP(S)、整窗关闭、outbox 重试和上下文隔离的现有测试。

## 验收标准

- 快速打开并关闭 HTTP(S) 新标签不再丢记录。
- Chrome 替换 tab ID 后关闭新 tab 不再丢记录。
- 已提交页面导航到新地址但尚未提交时，仍保存当前已提交页面。
- 不新增权限，不改变记录展示和持久化架构。
- 完整自动化测试与静态检查通过。
