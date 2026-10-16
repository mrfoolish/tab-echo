# Tab Echo 代码库层级与存储压力展示设计

## 目标

本次改造包含两个相互独立但适合连续实施的子项目：

1. 将扩展运行文件、自动化测试和设计文档放到清晰的顶层目录中，并删除无效维护入口。
2. 在设置页展示真实的浏览器存储压力，帮助用户在写入失败前发现容量风险。

两项工作都保持 Tab Echo 当前的本地优先架构，不增加后端、第三方依赖、扩展权限、内容脚本或远程资源。

## 代码库目录

目标结构如下：

```text
tab-echo/
├── extension/              # Chrome 加载已解压扩展时选择这里
│   ├── icons/
│   ├── lib/
│   ├── background.js
│   ├── dashboard.*
│   ├── popup.*
│   └── manifest.json
├── tests/
│   └── *.test.js
├── docs/
│   ├── adr/
│   ├── superpowers/
│   └── testing/
├── package.json
├── README.md
├── README.zh.md
├── proposal.md
├── CONTEXT.md
└── LICENSE
```

迁移规则：

- 将 `extension/tests/*.test.js` 移到根目录 `tests/`。
- 删除已经无法生成当前图标的 `extension/tools/generate-icons.js`，不保留会覆盖现有视觉资产的过期入口。
- `extension/` 只保留 Chrome 运行时会加载的代码与资源。
- 修复测试中的模块导入、扩展根目录推导和文档契约路径。
- 新增无第三方依赖且标记为 `private` 的 `package.json`，提供 `test` 和 `check` 脚本。
- `npm test` 运行根目录全部测试；`npm run check` 校验扩展 JavaScript、Manifest 与补丁格式。
- 更新 README 的目录树、加载路径和开发命令。
- 已完成的历史实施计划保留原始路径记录；当前使用说明和仍有效的验收命令改成新路径。

迁移先于 UI 功能实施，避免新增测试在旧目录中创建后立即再次移动。

## 存储模型

Tab Echo 没有一个可以安全相加的统一总容量：

- 常规关闭记录和回收站使用 IndexedDB，其配额由 Chrome 根据扩展源、设备空间和浏览器策略动态计算。
- 无痕关闭记录、共享设置和追踪快照使用 `chrome.storage.local`，受 Chrome 暴露的独立固定配额限制；设置页的无痕记录指标只计入无痕历史和无痕回收站。

两个存储池不能互相借用空间。因此 UI 不显示合计容量，也不使用合计后的百分比。总体压力等级取两个存储池中更高的一项。

## 后台健康响应

继续复用 `get-storage-health` 消息，并将响应整理为两个语义明确的存储池：

```js
{
  supported: true,
  level: 'normal' | 'elevated' | 'warning' | 'critical' | 'unknown',
  pools: {
    regularRecords: {
      supported: true,
      bytesUsed: 20971520,
      quotaBytes: 5368709120,
      usageRatio: 0.0039
    },
    localData: {
      supported: true,
      bytesUsed: 9437184,
      quotaBytes: 10485760,
      usageRatio: 0.9
    }
  },
  lastWriteFailure: null
}
```

约束：

- `regularRecords` 优先使用 `navigator.storage.estimate()` 的 IndexedDB 明细和扩展源配额。
- `localData` 分别测量无痕历史键和无痕回收站键，按 Chrome 配额规则动态扣除各自的“键名 + 空数组 `[]`”基线，再与 `QUOTA_BYTES` 计算比例；不计入共享设置、追踪快照和空集合固定元数据。
- 缺少任一浏览器能力时，只将对应存储池标记为不支持，不能伪造零占用。
- 保留现有顶层字段以避免后台测试和其他调用方出现不必要破坏；新增 `pools` 作为设置页的权威结构。
- 总体 `level` 使用可测量存储池中最高的压力等级。
- 阈值保持为 `<70%` 正常、`70%–84%` 使用偏高、`85%–94%` 接近上限、`>=95%` 空间不足风险。

## 设置页展示

在“保存与清理”标题下、三个保留规则输入框之前增加只读存储状态区：

```text
存储空间                              接近上限

常规关闭记录
20 MB / 5 GB · 不到 1%

无痕关闭记录
9 MB / 10 MB · 90%
```

交互与视觉规则：

- 两个存储池分行显示，不计算合计值。
- 顶部状态展示总体最高压力。
- 正常状态采用中性色，使用偏高与接近上限采用琥珀色，严重风险采用红色。
- 每个可测量存储池显示使用百分比和“已用 / 上限”；百分比低于 1% 时显示“不到 1%”。
- 无法测量的存储池显示“Chrome 暂未提供容量信息”，不显示进度值或 `0 MB`。
- 容量数据使用适合阅读的二进制单位格式化，最多保留一位小数。
- 状态区使用可访问的状态文本和进度语义，但不在页面加载时制造打断式播报。
- 中英文文案都描述产品语义，不向普通用户直接暴露 IndexedDB 名称。

## 数据流与失败处理

打开设置页时并行读取：

1. `get-settings`
2. `get-storage-health`

设置请求仍是页面可编辑的必要条件；健康请求是可选增强：

- 设置成功、健康失败：正常展示设置，并在状态区显示暂时无法获取容量。
- 设置失败、健康成功：保持当前设置加载失败行为，不能让健康信息掩盖错误。
- 保存设置成功：重新读取一次存储健康信息，以反映保留规则清理后的占用变化。
- 不轮询，不在历史和回收站页面后台获取容量。
- `lastWriteFailure` 存在时，状态区显示最近发生过存储写入失败；成功测量不会自动把该事实解释为已经恢复。

## 测试与验收

目录迁移测试：

- `npm test` 能发现并运行根目录 `tests/*.test.js`。
- 所有测试导入均指向 `extension/` 中的运行模块。
- `npm run check` 校验 JavaScript 语法、Manifest JSON 和补丁格式。
- 仓库不再暴露会生成旧版图标的命令；当前 `extension/icons/` 文件保持不变。

存储状态测试：

- 后台分别覆盖正常、偏高、接近上限、严重风险、部分能力不可用和全部能力不可用。
- Dashboard 覆盖两个存储池独立展示、总体状态取最高压力、容量格式化和未知状态。
- 健康请求失败不阻止设置加载；保存成功后触发一次健康刷新。
- 中英文文案、深浅主题、窄屏布局和进度语义保持可用。
- 在真实 Chrome 中验证显示值来自浏览器 API，且不会把两个配额池相加。

## 非目标

- 不申请 `unlimitedStorage`。
- 不增加手动清理按钮、缓存清理或数据导出入口。
- 不引入持续容量轮询或通知系统。
- 不改变默认 `maxRecords = 10000`、`maxAgeDays = null`、`trashMaxAgeDays = 3`。
- 不移动 `README.zh.md`、`proposal.md`、`CONTEXT.md` 或 `LICENSE`。
- 不在没有当前图标设计源的情况下创建新的图标生成脚本。
