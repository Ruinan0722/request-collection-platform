# 需求收集平台

React / Vite 前端与 FastAPI / SQLite 后端。仓库只含源码；运行会创建新的本地数据库。

在 backend 目录创建 Python 虚拟环境并安装 requirements.txt，运行：

    python -m uvicorn app.main:app --host 127.0.0.1 --port 17864

在另一个终端进入 frontend，运行：

    npm ci
    npm run dev

打开 http://localhost:17863/ 。本地开发身份只用于演示；部署前需独立配置认证和密钥。
