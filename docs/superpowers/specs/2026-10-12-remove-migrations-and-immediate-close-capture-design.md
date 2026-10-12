# 移除历史迁移与普通关闭立即记录设计

日期：2026-10-12

## 背景

Tab Echo 尚未发布，当前开发环境中的两层数据迁移均已完成：

1. 旧单体键 `tabEchoState` 向 v2 设置、常规/无痕历史和回收站分区迁移。
2. v2 常规历史和回收站数组向 IndexedDB generation 迁移。

继续保留这些迁移会增加启动分支、跨 Worker 竞态、一次性提示以及大量只服务于未发布版本的测试。现有 Chrome 配置里可能残留迁移 marker，但它们体积很小；本次不新增“最后一次清理迁移”，只停止读取和创建这些键。

同时，普通标签页关闭目前会等待 450ms，把同一窗口中连续关闭的标签页聚合为一条记录。关闭后立即打开 Popup 时，历史查询可能早于批次提交，导致本次会话中看不到刚关闭的标签页。稳定复现结果为：立即查询得到 0 条，等待约 500ms 后得到 1 条。

## 目标

- 删除所有面向未发布旧版本的数据迁移、恢复、marker 和迁移提示逻辑。
- 保留当前最终存储模型：常规关闭记录使用 IndexedDB，无痕关闭记录使用 `chrome.storage.local`，设置继续共享。
- 普通标签页关闭后立即生成并持久化一条记录。
- 只有关闭整个窗口时才生成标签页组。
- 同步更新自动化测试、README、proposal、ADR/设计说明和人工验收文档。

## 非目标

- 不主动删除现有浏览器配置中残留的旧迁移 marker 或旧数组。
- 不再保证从任何未发布旧版本自动升级。
- 不改变回收站、保留期限、排除域名、搜索、分页和重新打开语义。
- 不改变整窗关闭和 Chrome 强制退出时依赖持久化窗口快照的恢复机制。

## 最终存储架构

### 常规上下文

常规历史和回收站只以 IndexedDB generation 为权威数据源。`chrome.storage.local` 保存共享设置、revision 和当前 generation 指针，不再保存或读取常规历史/回收站数组。

generation 指针不存在时表示空集合，而不是“回退读取旧数组”。第一次写入会建立新的 generation、写入记录、校验写入结果，再提交 generation 指针。generation 指针是切换权威数据的唯一元数据，不再需要 migration marker。

### 无痕上下文

无痕历史和回收站继续直接保存在 `chrome.storage.local` 的独立分区。原因是 Chrome 会在最后一个无痕窗口关闭后销毁无痕 BrowserContext 的 IndexedDB。该行为是最终架构的一部分，不是兼容迁移路径。

### 迁移残留

代码停止读取和创建以下历史数据：

- `tabEchoState`
- `tabEcho:migration:v2`
- `tabEcho:migration-notice:v2`
- `tabEcho:indexeddb-migration:*`

已有配置中的这些键允许保留为不可达数据。新安装不会创建它们。

## 普通关闭与整窗关闭

### 普通标签页关闭

当 `tabs.onRemoved` 的 `isWindowClosing` 为 false 时：

1. 从已持久化的标签页快照构建单条关闭事件。
2. 将事件写入 durable outbox。
3. 持久化 tracker 状态。
4. 提交到当前上下文的历史存储。
5. 提交成功后从 outbox 确认移除。

不再创建普通关闭 pending batch，不再启动 450ms 定时器，也不再把连续关闭的标签页合并成 Group。Chrome 的“关闭其他标签页”“关闭右侧标签页”等操作会形成多条独立关闭记录。

### 关闭整个窗口

窗口关闭仍使用最后一次持久化的完整窗口快照：

1. `tabs.onRemoved` 且 `isWindowClosing` 为 true 时不生成普通单条事件。
2. `windows.onRemoved` 到达后使用完整窗口快照生成一个 Group。
3. `consumedWindowIds` 继续防止随后到达的标签移除事件产生重复记录。

即使窗口中只有一个可记录标签页，整窗关闭也继续按 Group 保存，以保留“这是一次窗口关闭”的来源语义。

## 组件调整

### `storage-repository.js`

- 删除 `MIGRATION_VERSION`、legacy/migration/notice 键及所有迁移方法。
- 删除旧默认值 `65536 / 30` 的识别与转换。
- 保留设置和无痕分区的校验、读写、revision、串行更新与重试。

### `indexeddb-migration.js`

整文件删除。其 generation 键定义和通用 yield helper 移入最终 IndexedDB 存储仓库；不保留 migrate/restore API。

### `indexeddb-storage-repository.js`

- 去除 migration 模块依赖和 `migrateLegacyState()`。
- 对启用 IndexedDB 的常规上下文，以 generation 指针是否存在判断空集合或活动集合。
- generation 不存在时不得读取常规 legacy 数组；第一次更新直接创建 generation。
- 无痕上下文继续委托本地存储仓库。

### `background.js`

- 删除迁移脚本导入、初始化迁移调用和迁移提示消息协议。
- 删除普通关闭计时器和批次调度。
- 普通标签移除在 tracker 串行队列中立即构建、持久化并提交事件。
- 整窗关闭路径保持独立。

### Popup 与完整页面

删除迁移提示节点、双语文案、读取/确认请求以及相应样式。页面启动只加载实际功能数据和设置。

## 错误处理与一致性

- 普通关闭事件在写入历史前先进入 durable outbox；IndexedDB 写入失败时不得确认 outbox，后续 tracker 事件或 Worker 启动可以重试。
- 缺少标签页快照、非 HTTP(S) 地址或命中排除域名时继续沿用现有忽略规则。
- generation 写入失败时不提交新指针，旧 generation 保持权威。
- 不通过读取旧数组兜底 IndexedDB 错误，避免形成新的隐式迁移路径。

## 测试策略

### 删除

- `indexeddb-migration.test.js` 整文件。
- `storage-repository.test.js` 中所有旧数据、marker、notice 和迁移恢复用例。
- Popup、Dashboard 和 Background 中的一次性迁移提示用例。
- 连续普通关闭聚合和普通 pending batch 定时恢复用例。

### 新增或调整

- 普通关闭后立即查询历史，必须已经包含该记录。
- 连续关闭同一窗口的多个标签页，必须生成多条独立记录。
- 整窗关闭仍生成一个完整 Group，且不重复。
- fresh profile 没有 generation 指针时，常规读取为空，且不会读取残留本地数组。
- 第一次常规写入直接创建 IndexedDB generation。
- 无痕读写继续使用本地分区。
- 生产代码、HTML、CSS、README 和 proposal 不再出现 migration notice、`tabEchoState` 或旧默认值 `65536 / 30`。

## 文档更新

- README 与 README.zh 删除数据迁移章节和迁移能力描述。
- 目录说明移除 `indexeddb-migration.js`。
- proposal 删除旧版本升级规则，改为只描述最终存储模型。
- 人工验收删除一次性迁移提示用例，增加普通关闭立即可见和连续关闭不聚合用例。
- ADR 0003 保留无痕不用 IndexedDB 的最终架构理由，但移除迁移/恢复表述。
- 历史计划文档作为决策记录不做逐字重写；新增设计和当前产品文档代表现行行为。

## 验收标准

- 正常关闭一个标签页后立即打开 Popup，可以看到该记录。
- 快速连续关闭多个标签页时，每个标签页形成独立记录。
- 关闭窗口时仍形成一个包含完整标签顺序的 Group。
- 常规历史和回收站只从 IndexedDB 读取；无痕历史和回收站只从本地分区读取。
- 新安装不创建或读取任何历史迁移键。
- 迁移提示不再出现在 Popup、完整页面、协议或文档中。
- 全量自动化测试与静态检查通过。
