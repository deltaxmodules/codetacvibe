import os

from flask import Flask, redirect, render_template, request, session, url_for

import db
from services import auth, items

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'chave-local-de-ensaio')
app.config['DATABASE'] = os.environ.get('APP_DATABASE', os.path.join(app.instance_path, 'app.sqlite'))
app.teardown_appcontext(db.close)
db.prepare(app.config['DATABASE'])
with app.app_context():
    auth.ensure_demo_user()


@app.get('/')
def login_form():
    return render_template('login.html', error=None)


@app.post('/login')
def login():
    user = auth.authenticate(request.form.get('username', ''), request.form.get('password', ''))
    if user is None:
        return render_template('login.html', error='Credenciais inválidas'), 401
    session['user'] = user
    return redirect(url_for('list_view'))


@app.get('/items')
def list_view():
    if 'user' not in session:
        return redirect(url_for('login_form'))
    return render_template('items.html', items=items.list_items(session['user']))


@app.post('/items')
def create_item():
    if 'user' not in session:
        return redirect(url_for('login_form'))
    items.add_item(session['user'], request.form.get('title', ''))
    return redirect(url_for('list_view'))


@app.post('/items/<int:item_id>/rename')
def rename_item(item_id):
    if 'user' not in session:
        return redirect(url_for('login_form'))
    changed = items.rename_item(session['user'], item_id, request.form.get('title', ''))
    return ('', 204) if changed else ('', 404)


@app.get('/erro')
def broken():
    return items.describe(None)


if __name__ == '__main__':
    app.run(port=int(os.environ.get('PORT', '5000')))
