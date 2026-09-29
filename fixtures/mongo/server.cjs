// Ensaio MongoDB: o driver oficial (notas) e o Mongoose (utilizadores).
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const mongoose = require('mongoose');

const url = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/codetac';
const client = new MongoClient(url);
const notes = () => client.db().collection('notes');

const User = mongoose.model('User', new mongoose.Schema({ email: String, name: String, plan: String }));

function checkNote(body) {
  if (!body?.text || typeof body.text !== 'string') throw new Error('text is required');
  return { text: body.text.trim(), tag: body.tag ?? 'general', at: new Date() };
}

async function saveNote(req, res) {
  const note = checkNote(req.body);
  const { insertedId } = await notes().insertOne(note);
  const total = await notes().countDocuments({ tag: note.tag });
  res.status(201).json({ id: insertedId, total });
}

async function listNotes(req, res) {
  const filter = req.query.tag ? { tag: req.query.tag } : {};
  res.json(await notes().find(filter).sort({ at: -1 }).limit(20).toArray());
}

async function tagNotes(req, res) {
  const { modifiedCount } = await notes().updateMany({ tag: req.params.tag }, { $set: { tag: req.body.to } });
  res.json({ modifiedCount });
}

async function forgetNotes(req, res) {
  const { deletedCount } = await notes().deleteMany({ tag: req.params.tag });
  res.json({ deletedCount });
}

async function register(req, res) {
  const existing = await User.findOne({ email: req.body.email });
  if (existing) return res.status(409).json({ error: 'exists' });
  const user = await User.create({ email: req.body.email, name: req.body.name, plan: 'free' });
  res.status(201).json({ id: user._id });
}

async function upgrade(req, res) {
  const user = await User.findOneAndUpdate({ email: req.body.email }, { plan: 'pro' }, { new: true });
  res.json({ plan: user?.plan ?? null });
}

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));
app.post('/api/notes', saveNote);
app.get('/api/notes', listNotes);
app.patch('/api/notes/tag/:tag', tagNotes);
app.delete('/api/notes/tag/:tag', forgetNotes);
app.post('/api/users', register);
app.post('/api/users/upgrade', upgrade);

async function start() {
  await client.connect();
  await mongoose.connect(url);
  await notes().deleteMany({});
  await User.deleteMany({});
  app.listen(Number(process.env.PORT ?? 3100), '127.0.0.1', () => console.log('ready'));
}
start();
