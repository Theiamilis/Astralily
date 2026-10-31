import uvicorn

from lily_model_vessel.app import app
from lily_model_vessel.settings import settings


if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)

