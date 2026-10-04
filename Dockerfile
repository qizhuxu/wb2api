# wb2api —— WorkBuddy 账号转 OpenAI 兼容网关（容器版）
#
#   构建：docker build -t wb2api .
#   运行：docker run -d -p 18788:18788 \
#           -v wb2api-data:/app/data -v %CD%/config.yaml:/app/config.yaml:ro wb2api
#   管理台：http://<host>:18788/ui/
#
# 说明（与 Windows 本机运行的差异）：
#   - 容器内没有 WorkBuddy.exe，**无法解密桌面端会话文件**（那条路依赖 Windows 原生绑定）。
#     所以容器版必须预先灌入凭证：把本机 `data/wb-session.json` 挂载/复制进容器的 /app/data。
#     挂载后由 refreshToken 自动续期，不需要再碰桌面端。
#   - 容器内必须绑 0.0.0.0 才能被端口映射访问（默认只监听回环）。
#   - 运行依赖只有 yaml；不入库的开发资料（test/、docs/、AGENTS.md）不 COPY 进来。
FROM node:24-alpine

WORKDIR /app

# 依赖层单独缓存：只有依赖清单变了才重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY ui/ ui/
COPY server.mjs config.yaml ./

ENV WB2API_HOST=0.0.0.0
ENV WB2API_PORT=18788

# data/ 放密钥与会话缓存；logs/ 放日志。两者都应挂载出来，否则重建容器就丢。
VOLUME ["/app/data", "/app/logs"]
EXPOSE 18788

# 健康检查只回答「进程是否在服务」：/health 恒返回 200（凭证状态在 body 里，不改状态码），
# 所以它**不**代表凭证可用 —— 凭证问题由管理台/自检页看。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
