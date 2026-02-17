# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

《全中国最激烈故事》在线阅读站——一部先锋/后现代主义中文小说的静态阅读网站。内容从 .docx 经 pandoc 转换导入，以 Astro 静态站发布。

## 常用命令

```bash
npm run dev          # 本地开发服务器
npm run build        # 构建（自动触发 postbuild 执行 pagefind 索引）
npm run test         # vitest 运行全部测试
npm run test:watch   # vitest watch 模式
npx vitest run tests/content-meta.test.mjs  # 运行单个测试文件
npm run check        # test + build 一起跑
npm run ingest:full -- "path/to/book.docx"  # 整本导入（需要 pandoc）
npm run ingest:chapter -- "path/to/chapter.docx"  # 单章增量导入
npm run optimize:images  # sharp 压缩 public/images/book-1 下的图片
```

## 架构

### 内容管线

.docx → `scripts/ingest.mjs`（调用 pandoc）→ Markdown 章节文件 + manifest JSON

- `scripts/ingest-lib.mjs`：导入核心逻辑（拆章、hash、manifest 读写）
- `content/manifests/book-1.json`：章节元数据清单，记录 chapter_id / order / content_hash / status
- 输出到 `src/content/chapters/{book_id}/{chapter_id}.md`

### Astro 内容集合

`src/content/config.ts` 定义两个集合：
- `books`：图书元数据（`src/content/books/`）
- `chapters`：章节内容，schema 含 book_id / chapter_id / order / title / source_type / content_hash / status

### 路由

- `/` — 首页（封面 + 阅读历史）
- `/book/[bookId]/` — 图书目录页
- `/book/[bookId]/chapter/[chapterId]` — 章节阅读页（含 giscus 评论、键盘左右切换章节）
- `/search` — Pagefind 全文搜索
- `/toc` — 总目录
- `/rss.xml` — RSS feed
- `/404` — 自定义 404

### 关键约定

- `chapter_id`（如 `b1-c001`）是永久主键，giscus 评论绑定 pathname，**不可随意变更**
- giscus 配置通过 `.env` 注入（`PUBLIC_GISCUS_*`），组件在 `src/components/GiscusComments.astro`
- 主题切换（dark/light）在 `BaseLayout.astro` 中处理，localStorage 读写均有 try/catch 保护
- 搜索页使用 Pagefind JS API 动态加载，结果渲染用 textContent（非 innerHTML）防 XSS

### 部署

- Canonical 主域名：Netlify (`cn-nonsense.netlify.app`)
- 镜像：Cloudflare Pages (`cn-nonsense.pages.dev`)
- `astro.config.mjs` 中 `site` 指向 Netlify 主域名
