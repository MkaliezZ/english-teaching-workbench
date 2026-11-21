# 英语教培工作台

[English](README.en.md) · [贡献指南](CONTRIBUTING.md) · [许可与来源](NOTICE.md) · [界面配色](docs/theme.md)

一个本地运行的英语教师工作台。课上模块将授权材料整理为可交互 HTML 和可编辑 PPTX，支持 K12 英语、托福和雅思三条教学轨道。自媒体模块通过独立安装的 self-media-bot 出稿。两个模块共用项目导航、成果卡和可记住的明暗模式。

## 本地启动

准备 Node.js 24 或更新版本、Python 3.11 或更新版本，以及 OpenSSL。Windows 可使用 Git for Windows 提供的 OpenSSL。

```sh
npm ci
python -m pip install -r requirements.txt
npm run build
npm run setup:local
npm start
```

打开 `https://127.0.0.1:8443`。启动脚本在 `.m0-data/` 下创建本机 HTTPS 证书，服务首次运行时在同一目录生成 `accounts.json`。登录选「教师」，使用其中 `teacher` 字段的值。证书仅用于本机开发，请按操作系统或浏览器的本机信任流程处理。

在「课上」选择轨道并上传 [自编示例](examples/library-club.txt)，即可生成并预览课堂包。也可使用有权处理的 PDF、DOCX、PPTX、TXT、Markdown、PNG、JPEG 或 WebP。PDF 可选页，默认读取前 3 页以内。浏览器通过 HTTPS API 和 SSE 读取任务状态及成果。

## 自媒体接入

按 [self-media-bot 文档](https://github.com/MkaliezZ/self-media-bot) 单独安装并配置 DeepSeek 和自媒体工作台，把 `M0_BOT_ROOT` 设为该 Bot 的源码目录后启动本项目。适配基线与许可见[许可与来源](NOTICE.md)。启用出稿时，提交的创作简报会交给已配置的上游模型处理。课件生成可在本机离线运行。

| 环境变量 | 用途 |
|---|---|
| `M0_DATA` | 本机数据目录，默认 `.m0-data/` |
| `M0_PORT` | 本机 HTTPS 端口，默认 `8443` |
| `M0_PYTHON` | 指向安装了依赖的 Python，默认 `python` |
| `M0_OPENSSL` | OpenSSL 路径覆盖 |
| `M0_BOT_ROOT` | 可选的 self-media-bot 源码目录 |

## 验证与公开范围

完成安装及构建后运行 `npm test`。测试使用独立临时数据，在本机验证登录、三轨 HTML/PPTX 生成和 SSE 状态读取。公开版为环回监听的 M0 开发原型。公开资产包含源码和自编示例，机构教材、题库、教材专用样例、历史产物、账号与本机运行数据由其各自的来源和授权管理。[公开清单](PUBLICATION.json)
