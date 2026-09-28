import os

import asyncpg
import psycopg
import psycopg2

DSN = os.environ.get('PG_DSN', 'postgresql://ensaio:ensaio@127.0.0.1:5432/ensaio')


def reset():
    with psycopg.connect(DSN, autocommit=True) as connection:
        connection.execute('drop table if exists pg_items')
        connection.execute('create table pg_items (id serial primary key, library text, title text)')


# psycopg 3, sync
def psycopg_insert(connection, title):
    connection.execute('insert into pg_items (library, title) values (%s, %s)', ('psycopg', title))


def psycopg_select(connection):
    with connection.cursor() as cursor:
        cursor.execute('select id, title from pg_items where library = %s', ('psycopg',))
        return cursor.fetchall()


def psycopg_touch_missing(connection):
    return connection.execute('update pg_items set title = %s where id = -1', ('nada',)).rowcount


def psycopg_delete(connection):
    return connection.execute("delete from pg_items where library = 'psycopg'").rowcount


def run_psycopg(title):
    with psycopg.connect(DSN) as connection:
        psycopg_insert(connection, title)
        rows = psycopg_select(connection)
        missing = psycopg_touch_missing(connection)
        deleted = psycopg_delete(connection)
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}


# psycopg 3, async
async def psycopg_async_insert(connection, title):
    await connection.execute('insert into pg_items (library, title) values (%s, %s)', ('psycopg-async', title))


async def psycopg_async_select(connection):
    cursor = await connection.execute('select id, title from pg_items where library = %s', ('psycopg-async',))
    return await cursor.fetchall()


async def psycopg_async_touch_missing(connection):
    return (await connection.execute('update pg_items set title = %s where id = -1', ('nada',))).rowcount


async def psycopg_async_delete(connection):
    return (await connection.execute("delete from pg_items where library = 'psycopg-async'")).rowcount


async def run_psycopg_async(title):
    async with await psycopg.AsyncConnection.connect(DSN) as connection:
        await psycopg_async_insert(connection, title)
        rows = await psycopg_async_select(connection)
        missing = await psycopg_async_touch_missing(connection)
        deleted = await psycopg_async_delete(connection)
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}


# psycopg2
def psycopg2_insert(cursor, title):
    cursor.execute('insert into pg_items (library, title) values (%s, %s)', ('psycopg2', title))


def psycopg2_select(cursor):
    cursor.execute('select id, title from pg_items where library = %s', ('psycopg2',))
    return cursor.fetchall()


def psycopg2_touch_missing(cursor):
    cursor.execute('update pg_items set title = %s where id = -1', ('nada',))
    return cursor.rowcount


def psycopg2_delete(cursor):
    cursor.execute("delete from pg_items where library = 'psycopg2'")
    return cursor.rowcount


def run_psycopg2(title):
    connection = psycopg2.connect(DSN)
    try:
        with connection, connection.cursor() as cursor:
            psycopg2_insert(cursor, title)
            rows = psycopg2_select(cursor)
            missing = psycopg2_touch_missing(cursor)
            deleted = psycopg2_delete(cursor)
    finally:
        connection.close()
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}


# asyncpg
async def asyncpg_insert(connection, title):
    await connection.execute('insert into pg_items (library, title) values ($1, $2)', 'asyncpg', title)


async def asyncpg_select(connection):
    return await connection.fetch('select id, title from pg_items where library = $1', 'asyncpg')


async def asyncpg_touch_missing(connection):
    return await connection.execute('update pg_items set title = $1 where id = -1', 'nada')


async def asyncpg_delete(connection):
    return await connection.execute("delete from pg_items where library = 'asyncpg'")


async def run_asyncpg(title):
    connection = await asyncpg.connect(DSN)
    try:
        await asyncpg_insert(connection, title)
        rows = await asyncpg_select(connection)
        missing = await asyncpg_touch_missing(connection)
        deleted = await asyncpg_delete(connection)
    finally:
        await connection.close()
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}
