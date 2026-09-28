from fastapi import FastAPI
from pydantic import BaseModel

from services import ai, mail, reports, storage, web

app = FastAPI()


class Question(BaseModel):
    text: str


class Upload(BaseModel):
    name: str
    content: str


class Receipt(BaseModel):
    to: str
    total: float


class Rows(BaseModel):
    rows: list[list[str]]


@app.post('/ai/openai')
async def ask_openai(question: Question):
    return await ai.ask_openai(question.text)


@app.post('/ai/openai-stream')
async def stream_openai(question: Question):
    return await ai.stream_openai(question.text)


@app.post('/ai/anthropic')
def ask_anthropic(question: Question):
    return ai.ask_anthropic(question.text)


@app.get('/web/requests')
def with_requests():
    return web.with_requests()


@app.get('/web/urllib')
def with_urllib():
    return web.with_urllib()


@app.get('/web/aiohttp')
async def with_aiohttp():
    return await web.with_aiohttp()


@app.post('/files/upload')
def upload(item: Upload):
    return storage.upload(item.name, item.content)


@app.get('/files/link/{name}')
def share(name: str):
    return storage.share(name)


@app.post('/email')
def send_receipt(receipt: Receipt):
    return mail.send_receipt(receipt.to, receipt.total)


@app.post('/export')
def export(rows: Rows):
    return reports.export(rows.rows)
