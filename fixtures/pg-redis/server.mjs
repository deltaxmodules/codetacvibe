// Ensaio da Etapa 4 da v2: postgres.js (ESM), ioredis e node-redis.
import express from 'express';
import postgres from 'postgres';
import Redis from 'ioredis';
import { createClient } from 'redis';

const sql = postgres(process.env.PG_URL, { onnotice: () => {} });
const cache = new Redis(process.env.REDIS_URL);
const sessions = createClient({ url: process.env.REDIS_URL });
await sessions.connect();
await sql`create table if not exists orders (id serial primary key, customer text not null, total numeric not null, status text not null default 'open')`;

async function createOrder(req, res) {
  const { customer, total } = req.body;
  const [order] = await sql`insert into orders (customer, total) values (${customer}, ${total}) returning id`;
  await cache.hset(`cart:${order.id}`, 'customer', customer, 'total', String(total));
  await cache.expire(`cart:${order.id}`, 600);
  res.status(201).json(order);
}

async function listOrders(req, res) {
  const key = `orders:${req.query.status}`;
  const cached = await cache.get(key);
  if (cached) return res.json(JSON.parse(cached));
  const rows = await sql`select id, total from orders where status = ${req.query.status} order by id`;
  await cache.set(key, JSON.stringify(rows), 'EX', 30);
  res.json(rows);
}

async function payOrders(req, res) {
  const paid = await sql.begin(async tx => {
    const rows = await tx`update orders set status = 'paid' where customer = ${req.body.customer} and status = 'open' returning id`;
    await tx`insert into orders (customer, total, status) values (${'audit'}, 0, ${'log'})`;
    return rows.length;
  });
  const pipeline = cache.pipeline();
  pipeline.del('orders:open');
  pipeline.incr('stats:payments');
  await pipeline.exec();
  res.json({ paid });
}

async function login(req, res) {
  const token = req.body.token;
  await sessions.set(`session:${token}`, JSON.stringify({ user: req.body.user }), { EX: 300 });
  await sessions.multi().incr('stats:logins').sAdd('online', req.body.user).exec();
  res.json({ ok: true });
}

async function logout(req, res) {
  const removed = await sessions.del(`session:${req.body.token}`);
  const still = await sessions.exists(`session:${req.body.token}`);
  res.json({ removed, still });
}

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));
app.post('/api/orders', createOrder);
app.get('/api/orders', listOrders);
app.post('/api/orders/pay', payOrders);
app.post('/api/login', login);
app.post('/api/logout', logout);
app.listen(Number(process.env.PORT), '127.0.0.1');
