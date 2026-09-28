import hashlib

import db


def hash_password(password):
    return hashlib.sha256(('sal-de-ensaio:' + password).encode()).hexdigest()


def authenticate(username, password):
    user = db.find_user(username)
    if user is None or user['password_hash'] != hash_password(password):
        return None
    return user['id']


def ensure_demo_user():
    db.insert_user('ana', hash_password('palavra-passe-de-ensaio'))
