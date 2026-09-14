FROM node:22-alpine AS build
WORKDIR /app

# Reuse the repository lockfile, including the Vite version used locally.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY website/ ./website/
COPY docs/images/ ./docs/images/
RUN npm --prefix website run build

FROM nginx:stable-alpine AS runtime
COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/website/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
