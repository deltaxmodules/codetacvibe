// Ensaio Prisma 7 com adaptador (better-sqlite3): o SQL já é visto pelo driver.
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: 'file:./dev.db' }) });

async function createInvoice(req, res) {
  const invoice = await prisma.invoice.create({ data: { customer: req.body.customer, total: req.body.total } });
  res.status(201).json({ id: invoice.id });
}

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));
app.post('/api/invoices', createInvoice);
app.listen(Number(process.env.PORT ?? 3300), '127.0.0.1', () => console.log('ready'));
