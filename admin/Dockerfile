# WinClaw 自动更新管理端 —— 零依赖构建（无 npm 安装），可在离线服务器上构建
FROM node:22-alpine

WORKDIR /app
COPY . /app

EXPOSE 8091
CMD ["node", "/app/server.js"]