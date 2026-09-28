from fastapi import FastAPI, WebSocket

from services import cpu, dashboard, report

app = FastAPI()


@app.get('/report')
def get_report(size: int = 5):
    return report.build_report(size)


@app.get('/cpu')
def get_cpu(count: int = 500):
    return {'score': cpu.score(count)}


@app.get('/dashboard')
async def get_dashboard():
    return await dashboard.load_dashboard()


@app.websocket('/ws')
async def echo(socket: WebSocket):
    await socket.accept()
    text = await socket.receive_text()
    await socket.send_text(reply(text))
    await socket.close()


def reply(text):
    return 'eco: ' + text
