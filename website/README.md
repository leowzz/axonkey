# Axonkey 官网

独立的中文产品官网，使用原生 HTML、CSS、JavaScript 与 Vite。网站源码位于此目录，应用截图与根目录 README 共用 `../docs/images/axonkey-home.png`、`../docs/images/axonkey-overview.png` 和 `../docs/images/axonkey-mapping.png`，只维护一份源文件。Vite 构建时自动打包这些共享图片。其他图片来自项目已有产品素材。

## 本地预览

项目根目录已安装依赖时可直接运行：

```sh
cd website
npm run dev
```

访问 http://127.0.0.1:4175 。也可以在本目录单独执行 `npm install` 后运行。

## 构建

```sh
npm run build
npm run preview
```

`dist/` 可部署至任意静态网站服务。使用相对资源路径，支持子路径部署。

页面包括产品介绍、三项核心功能、可切换的真实应用截图、本地数据说明和下载入口。下载按钮前往官方 GitHub 最新发行页，由用户选择对应平台安装包，不硬编码版本和下载地址。

功能和系统要求依据项目 README；更新支持范围时应同步网站文案。此目录仅完成本地网站，没有发布到外部服务。
