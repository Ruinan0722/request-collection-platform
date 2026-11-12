"""本地启动入口：python -m app 或 uvicorn app.main:app"""

import uvicorn

from app.config.settings import settings


def main() -> None:
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.backend_port,
        reload=settings.is_dev,
    )


if __name__ == "__main__":
    main()
