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

## Docker 镜像发布

推送 `vMAJOR.MINOR.PATCH` Git tag 时，`.github/workflows/build-website-image.yml` 自动构建官网并发布到本仓库关联的 GitHub Container Registry：

```text
ghcr.io/leowzz/axonkey-website:vMAJOR.MINOR.PATCH
```

镜像 tag 完整保留 Git tag（包含 `v`），支持 `linux/amd64` 和 `linux/arm64`。不发布浮动 `latest`，避免补发旧版本时覆盖当前版本。官网 workflow 与桌面安装包 workflow 独立运行，复用现有 tag 格式与提交分支校验。

发布使用 GitHub Actions 自带的 `GITHUB_TOKEN`，权限为 `contents: read` 和 `packages: write`，无需配置 Docker Hub 密钥。首次发布后若需要匿名拉取，在仓库关联的 Packages 设置中将镜像可见性设为 Public。

用实际发布版本替换下面的占位符：

```sh
docker run -d --name axonkey-website --restart unless-stopped \
  -p 8080:80 ghcr.io/leowzz/axonkey-website:vMAJOR.MINOR.PATCH
```

在仓库根目录本地构建：

```sh
docker build -f website/Dockerfile -t axonkey-website:local .
docker run --rm -p 8080:80 axonkey-website:local
```

访问 `http://localhost:8080`。构建上下文必须是仓库根目录，以包含根锁文件及共用截图；专用 `.dockerignore` 排除其他源码、凭据和本地产物。最终镜像仅包含 Nginx 与构建后的官网静态文件。
