from sqlalchemy import select, update

from db import Note


async def create_note(session, title):
    note = Note(title=clean_title(title))
    session.add(note)
    await session.commit()
    return note


def clean_title(title):
    return ' '.join(title.split())


async def list_notes(session):
    result = await session.execute(select(Note).order_by(Note.id))
    return [summary(note) for note in result.scalars()]


def summary(note):
    return {'id': note.id, 'title': note.title}


async def rename_note(session, note_id, title):
    result = await session.execute(update(Note).where(Note.id == note_id).values(title=clean_title(title)))
    await session.commit()
    return result.rowcount
