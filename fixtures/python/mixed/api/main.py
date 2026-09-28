import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services import tasks

app = FastAPI()
# Only for the variant without the Vite proxy: the page calls this origin directly.
if os.environ.get('FRONTEND_ORIGIN'):
    app.add_middleware(CORSMiddleware, allow_origins=[os.environ['FRONTEND_ORIGIN']], allow_methods=['*'], allow_headers=['*'])


class TaskIn(BaseModel):
    title: str


@app.get('/api/tasks')
def list_tasks():
    return tasks.list_tasks()


@app.post('/api/tasks', status_code=201)
def create_task(payload: TaskIn):
    return tasks.add_task(payload.title)
