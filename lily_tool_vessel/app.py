import uvicorn

from lily_tool_vessel.app import HOST, PORT, app


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
