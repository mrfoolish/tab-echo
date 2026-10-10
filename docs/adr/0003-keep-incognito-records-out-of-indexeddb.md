# 在无痕上下文中不使用 IndexedDB 保存记录

Chrome 的 split incognito Worker 与常规 Worker 拥有不同的 IndexedDB 存储分区。真实 Chrome 验证表明：关闭最后一个无痕窗口后，无痕 BrowserContext 的 IndexedDB 数据会被销毁，但共享的 `chrome.storage.local` 元数据仍会保留。若无痕记录继续使用 IndexedDB，而活动 generation 指针保存在 `chrome.storage.local`，下次打开无痕窗口时就可能出现“指针仍在、记录已消失”的不一致状态。

因此，常规上下文的历史和回收站继续使用 IndexedDB；无痕上下文的历史和回收站改用按 mode 隔离的 `chrome.storage.local` 数组。共享设置仍保存在 `chrome.storage.local`，但常规和无痕内容保持独立键和独立 revision。升级时，若旧的无痕 IndexedDB generation 仍可读取，则先完整校验并迁回 local 数组，成功后才清除 generation 和 marker；若记录已经被 Chrome 销毁，则保留指针并明确报错，不能用空数组覆盖或把数据丢失误判为成功迁移。

这一选择使关闭最后一个无痕窗口、Chrome 强制退出和之后重新打开无痕窗口时仍能恢复记录，同时保留常规大数据量分页查询的 IndexedDB 性能收益。代价是两个上下文使用不同的底层存储实现，因此所有仓储能力必须继续通过统一 repository 接口暴露，并用常规/无痕回归测试保持行为一致。
