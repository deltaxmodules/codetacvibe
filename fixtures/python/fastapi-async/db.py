import os

from sqlalchemy import ForeignKey, String
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DATABASE_URL = os.environ.get('APP_DATABASE_URL', 'sqlite+aiosqlite:///./instance/notes.sqlite')
engine = create_async_engine(DATABASE_URL)
Session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Note(Base):
    __tablename__ = 'notes'
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))


class Audit(Base):
    __tablename__ = 'audit'
    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int] = mapped_column(ForeignKey('notes.id'))
    event: Mapped[str] = mapped_column(String(40))


async def create_tables():
    if DATABASE_URL.startswith('sqlite+aiosqlite:///./'):
        os.makedirs(os.path.dirname(DATABASE_URL.split(':///', 1)[1]), exist_ok=True)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


async def get_session():
    async with Session() as session:
        yield session
