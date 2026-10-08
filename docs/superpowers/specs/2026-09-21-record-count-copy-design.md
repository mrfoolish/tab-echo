# 关闭记录计数与汇总文案设计

状态：已确认

## 目标

消除完整页与弹窗在无搜索状态下对关闭记录数量的口径差异，并明确说明关闭记录中可能包含标签组。

## 计数口径

- `totalEventCount` 表示当前上下文底层保存的全部关闭事件数。单条记录计一条，一个标签组也计一条。
- `resultEventCount` 表示经过搜索和单标签网址展示去重后的结果数。
- `totalTabCount` 表示全部底层关闭事件包含的标签页总数。
- 无搜索词时，完整页与弹窗的汇总都使用 `totalEventCount`。
- 有搜索词时，汇总使用 `resultEventCount`，表示当前搜索条件下可识别的结果数。
- 弹窗无搜索词时不在“打开完整列表”按钮上展示去重后的结果数，避免与底层总记录数并排产生冲突。有搜索词时，“查看全部”继续使用 `resultEventCount`。

## 文案

- 完整页中文汇总：`{events} 条记录（含标签组）· {tabs} 个标签页`。
- 完整页英文汇总：`{events} records (including Groups) · {tabs} tabs`。
- 弹窗无搜索中文汇总：`{count} 条记录（含标签组）`。
- 弹窗无搜索英文汇总：`{count} records (including Groups)`。
- 弹窗无搜索入口：`打开完整列表` / `Open full list`，不显示数量。
- 弹窗搜索状态维持 `{count} 条匹配记录` / `{count} matching records`。

## 操作范围

- 弹窗“移至回收站”仍只处理当前展示的记录。
- “移除全部结果”无搜索词时按 `totalEventCount` 显示影响数量，并永久移除全部底层记录。
- “移除全部结果”有搜索词时按 `resultEventCount` 显示影响数量，并永久移除全部匹配结果。

## 测试

以后台同时返回 `totalEventCount: 2690`、`resultEventCount: 2008`、`totalTabCount: 2712` 为回归场景：弹窗无搜索汇总必须显示 2690，入口只显示“打开完整列表”且不出现 2008，批量永久移除确认必须显示 2690。搜索状态仍显示搜索结果数，并显示“查看全部 8 条结果”。
