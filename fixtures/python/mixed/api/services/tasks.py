import os
import sqlite3

DATABASE = os.environ.get('APP_DATABASE', os.path.join(os.path.dirname(__file__), '..', 'instance', 'tasks.sqlite'))


def connect():
    os.makedirs(os.path.dirname(DATABASE), exist_ok=True)
    db = sqlite3.connect(DATABASE)
    db.execute('create table if not exists tasks (id integer primary key, title text)')
    return db


def list_tasks():
    with connect() as db:
        return [{'id': row[0], 'title': row[1]} for row in db.execute('select id, title from tasks order by id')]


def add_task(title):
    title = clean(title)
    with connect() as db:
        cursor = db.execute('insert into tasks (title) values (?)', (title,))
        return {'id': cursor.lastrowid, 'title': title}


def clean(title):
    return ' '.join(title.split())
