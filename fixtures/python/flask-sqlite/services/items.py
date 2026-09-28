import db


def list_items(owner):
    return [describe(row) for row in db.select_items(owner)]


def describe(row):
    return {'id': row['id'], 'title': row['title'].strip()}


def add_item(owner, title):
    title = normalise(title)
    if not title:
        raise ValueError('título vazio')
    db.insert_item(owner, title)


def normalise(title):
    return ' '.join(title.split())


def rename_item(owner, item_id, title):
    return db.rename_item(owner, item_id, normalise(title))
