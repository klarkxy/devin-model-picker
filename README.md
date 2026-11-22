# Devin Model Picker

为 Devin 桌面版把自定义 OpenAI / Anthropic 兼容接口（BYOK）的模型注入原生模型目录，并提供「BYOK Fusion」双槽位（主 Agent + Sidekick）组合，由渲染进程里的卡片选择器自由搭配。

## 功能

- 在原生模型列表中追加 BYOK 供应商模型（按推理档位展开变体）
- 固定 `BYOK Fusion` 槽位 a/b：可从 BYOK 或已观测到的原生模型中挑选主/Sidekick，编辑器内直接切换
- 独立本地后端（`127.0.0.1:39852`）代理聊天请求到各供应商，密钥只写入本地 `config.json`，不进入任何面板/选择器响应
- 最小化中文设置面板：供应商增删改、模型导入（provider `/models` + models.dev 元数据合并）、启用开关、元数据刷新

## 安装

```bash
npm run package   # 产出 devin-model-picker-<version>.vsix
```

然后在 Devin 中「从 VSIX 安装」。也可以直接从 [Releases](https://github.com/klarkxy/devin-model-picker/releases/latest) 下载打包好的 `.vsix`。

已安装的扩展每 6 小时自动检查 GitHub Releases 并提示更新；也可在命令面板执行「Model Picker：检查更新」手动检查。

> **注意**：本扩展会向 Devin 的 `workbench.html` 注入一个 `<script>` 标签并更新 `product.json` 校验和，用于加载选择器脚本。每次激活时自动重新应用（Devin 升级后会自愈）；卸载扩展或执行「停用并恢复」会移除注入。若安装目录无写权限会在通知中提示。

## 设置

命令面板执行 `Devin Model Picker：设置`（或点击状态栏「Model Picker」）：

- 添加/编辑供应商：名称、API 地址（显示归一化后的请求地址）、密钥（密文输入，编辑时留空表示沿用旧密钥）、接口类型（OpenAI / OpenAI Responses / Anthropic）
- 「导入模型」调用供应商 `/models` 并与 models.dev 元数据合并后勾选保存
- 每个模型可单独启用/移除；「刷新元数据」重新拉取

## 停用与卸载

- `Devin Model Picker：停用并恢复`：关闭全部注入钩子、按收据还原被本扩展修改过的设置、移除 workbench 注入
- 直接卸载扩展时 `vscode:uninstall` 钩子同样会移除注入并还原设置
- 检测到旧版 `Devin Fusion BYOK` 仍在启用时本扩展不会启动，请先停用旧版

## 其他命令

- `Devin Model Picker：重新注入选择器` — 手动重新应用 workbench 注入
