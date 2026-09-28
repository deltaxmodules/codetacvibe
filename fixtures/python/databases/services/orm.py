import os

from sqlalchemy import create_engine, delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import Field, Session, SQLModel

DSN = os.environ.get('PG_DSN', 'postgresql://ensaio:ensaio@127.0.0.1:5432/ensaio')
SQLITE = os.environ.get('APP_DATABASE_URL_SYNC', 'sqlite:///./instance/orm.sqlite')


class OrmItem(SQLModel, table=True):
    __tablename__ = 'orm_items'
    id: int | None = Field(default=None, primary_key=True)
    title: str


sync_engine = create_engine(DSN.replace('postgresql://', 'postgresql+psycopg://'))
async_engine = create_async_engine(DSN.replace('postgresql://', 'postgresql+asyncpg://'))
sqlite_engine = create_engine(SQLITE)


def reset():
    for engine in (sync_engine, sqlite_engine):
        SQLModel.metadata.drop_all(engine)
        SQLModel.metadata.create_all(engine)


def orm_insert(session, title):
    session.add(OrmItem(title=title))
    session.commit()


def orm_select(session):
    return session.exec(select(OrmItem)).all() if hasattr(session, 'exec') else session.execute(select(OrmItem)).all()


def orm_touch_missing(session):
    result = session.execute(update(OrmItem).where(OrmItem.id == -1).values(title='nada'))
    session.commit()
    return result.rowcount


def orm_delete(session):
    result = session.execute(delete(OrmItem))
    session.commit()
    return result.rowcount


def run_sync(engine, title):
    with Session(engine) as session:
        orm_insert(session, title)
        rows = orm_select(session)
        missing = orm_touch_missing(session)
        deleted = orm_delete(session)
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}


async def orm_async_insert(connection, title):
    await connection.execute(OrmItem.__table__.insert().values(title=title))


async def orm_async_select(connection):
    return (await connection.execute(select(OrmItem.__table__))).all()


async def orm_async_touch_missing(connection):
    return (await connection.execute(update(OrmItem.__table__).where(OrmItem.__table__.c.id == -1).values(title='nada'))).rowcount


async def orm_async_delete(connection):
    return (await connection.execute(delete(OrmItem.__table__))).rowcount


async def run_async(title):
    async with async_engine.begin() as connection:
        await orm_async_insert(connection, title)
        rows = await orm_async_select(connection)
        missing = await orm_async_touch_missing(connection)
        deleted = await orm_async_delete(connection)
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}
