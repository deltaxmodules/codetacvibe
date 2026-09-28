import os
import sqlite3

from flask import current_app, g


def connect():
    if 'db' not in g:
        g.db = sqlite3.connect(current_app.config['DATABASE'])
        g.db.row_factory = sqlite3.Row
    return g.db


def close(error=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def prepare(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(
            'create table if not exists users (id integer primary key, username text unique, password_hash text);'
            'create table if not exists items (id integer primary key, owner integer, title text);'
        )


def find_user(username):
    return connect().execute('select id, password_hash from users where username = ?', (username,)).fetchone()


def insert_user(username, password_hash):
    connect().execute('insert or ignore into users (username, password_hash) values (?, ?)', (username, password_hash))
    connect().commit()


def select_items(owner):
    return connect().execute('select id, title from items where owner = ? order by id', (owner,)).fetchall()


def insert_item(owner, title):
    connect().execute('insert into items (owner, title) values (?, ?)', (owner, title))
    connect().commit()


def rename_item(owner, item_id, title):
    cursor = connect().execute('update items set title = ? where id = ? and owner = ?', (title, item_id, owner))
    connect().commit()
    return cursor.rowcount
