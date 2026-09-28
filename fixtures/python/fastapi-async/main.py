from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

import db
from services import audit, external, notes


@asynccontextmanager
async def lifespan(app):
    await db.create_tables()
    yield


app = FastAPI(lifespan=lifespan)


class NoteIn(BaseModel):
    title: str


@app.post('/notes', status_code=201)
async def create_note(payload: NoteIn, background: BackgroundTasks, session: AsyncSession = Depends(db.get_session)):
    note = await notes.create_note(session, payload.title)
    background.add_task(audit.record, note.id, 'CREATED')
    return notes.summary(note)


@app.get('/notes')
async def list_notes(session: AsyncSession = Depends(db.get_session)):
    return await notes.list_notes(session)


@app.patch('/notes/{note_id}')
async def rename_note(note_id: int, payload: NoteIn, session: AsyncSession = Depends(db.get_session)):
    if not await notes.rename_note(session, note_id, payload.title):
        raise HTTPException(status_code=404)
    return {'id': note_id}


@app.get('/forecast/{city}')
async def forecast(city: str):
    return await external.fetch_forecast(city)
