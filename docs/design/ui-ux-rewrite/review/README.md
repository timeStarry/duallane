# PR 视觉证据

本目录是仓库有意保留的两张评审截图，只用于展示此次正式 UI 实现；它们不是规范值源。
使用 `features/settings/verify-appearance.mjs` 渲染正式 React App，身份与所有 API 响应均为
合成数据，未使用真实账号、会话内容或生产服务。截图采用极简深色主题。

| 文件 | 视口 | 评审内容 |
| --- | --- | --- |
| [桌面](appearance-desktop.png) | 1440 × 960 | 设置层级、五主题缩略窗、标题、图文模式选择、密度、退出按钮和开关 |
| [手机](appearance-mobile.png) | 390 × 844 | 单层设置、横向主题浏览、图文分段选择及触控尺寸 |

复现命令（仓库根目录，依赖和 Playwright Chromium 已安装）：

```sh
node apps/web/src/features/settings/verify-appearance.mjs
```

脚本的完整矩阵和原始输出继续保留在忽略目录 `.private-test-results/appearance-refinement`。
只有上述人工检查过的合成截图进入文档；失败 trace、数据库、令牌、上传字节及用户截图不提交。
