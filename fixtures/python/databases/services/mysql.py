import os

import pymysql

SETTINGS = dict(host='127.0.0.1', port=int(os.environ.get('MYSQL_PORT', '3306')), user=os.environ.get('MYSQL_USER', 'ensaio'),
                password=os.environ.get('MYSQL_PASSWORD', ''), database=os.environ.get('MYSQL_DATABASE', 'ensaio'))


def reset():
    connection = pymysql.connect(**SETTINGS, autocommit=True)
    with connection.cursor() as cursor:
        cursor.execute('drop table if exists my_items')
        cursor.execute('create table my_items (id int auto_increment primary key, title varchar(200))')
    connection.close()


def mysql_insert(cursor, title):
    return cursor.execute('insert into my_items (title) values (%s)', (title,))


def mysql_insert_many(cursor, titles):
    return cursor.executemany('insert into my_items (title) values (%s)', [(title,) for title in titles])


def mysql_select(cursor):
    cursor.execute('select id, title from my_items')
    return cursor.fetchall()


def mysql_touch_missing(cursor):
    return cursor.execute('update my_items set title = %s where id = -1', ('nada',))


def mysql_delete(cursor):
    return cursor.execute('delete from my_items')


def run_pymysql(title):
    connection = pymysql.connect(**SETTINGS)
    try:
        with connection.cursor() as cursor:
            mysql_insert(cursor, title)
            mysql_insert_many(cursor, [title + '-2', title + '-3'])
            rows = mysql_select(cursor)
            missing = mysql_touch_missing(cursor)
            deleted = mysql_delete(cursor)
        connection.commit()
    finally:
        connection.close()
    return {'rows': len(rows), 'missing': missing, 'deleted': deleted}
