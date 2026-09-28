from db import Audit, Session


async def record(note_id, event):
    async with Session() as session:
        session.add(Audit(note_id=note_id, event=label(event)))
        await session.commit()


def label(event):
    return event.lower()
