from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

from services import mysql, orm, postgres


@asynccontextmanager
async def lifespan(app):
    postgres.reset()
    mysql.reset()
    orm.reset()
    yield


app = FastAPI(lifespan=lifespan)


class Item(BaseModel):
    title: str


@app.post('/psycopg')
def with_psycopg(item: Item):
    return postgres.run_psycopg(item.title)


@app.post('/psycopg-async')
async def with_psycopg_async(item: Item):
    return await postgres.run_psycopg_async(item.title)


@app.post('/psycopg2')
def with_psycopg2(item: Item):
    return postgres.run_psycopg2(item.title)


@app.post('/asyncpg')
async def with_asyncpg(item: Item):
    return await postgres.run_asyncpg(item.title)


@app.post('/pymysql')
def with_pymysql(item: Item):
    return mysql.run_pymysql(item.title)


@app.post('/sqlalchemy-psycopg')
def with_sqlalchemy(item: Item):
    return orm.run_sync(orm.sync_engine, item.title)


@app.post('/sqlalchemy-asyncpg')
async def with_sqlalchemy_async(item: Item):
    return await orm.run_async(item.title)


@app.post('/sqlmodel-sqlite')
def with_sqlmodel(item: Item):
    return orm.run_sync(orm.sqlite_engine, item.title)
