// Ensaio Prisma 6 com o motor nativo (SQLite): as queries correm em Rust.
const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function readInvoice(body) {
  if (!body?.customer || typeof body.total !== 'number') throw new Error('customer and total are required');
  return { customer: body.customer, total: body.total };
}

async function createInvoice(req, res) {
  const invoice = await prisma.invoice.create({ data: readInvoice(req.body) });
  const open = await prisma.invoice.count({ where: { status: 'open' } });
  res.status(201).json({ id: invoice.id, open });
}

async function listInvoices(req, res) {
  res.json(await prisma.invoice.findMany({ where: { customer: req.query.customer }, orderBy: { id: 'desc' } }));
}

async function closeAll(req, res) {
  const { count } = await prisma.invoice.updateMany({ where: { customer: req.params.customer }, data: { status: 'paid' } });
  res.json({ count });
}

async function removeLatest(req, res) {
  const latest = await prisma.invoice.findFirst({ where: { customer: req.params.customer }, orderBy: { id: 'desc' } });
  if (!latest) return res.status(404).end();
  await prisma.invoice.delete({ where: { id: latest.id } });
  res.status(204).end();
}

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));
app.post('/api/invoices', createInvoice);
app.get('/api/invoices', listInvoices);
app.post('/api/invoices/pay/:customer', closeAll);
app.delete('/api/invoices/latest/:customer', removeLatest);

prisma.invoice.deleteMany().then(() =>
  app.listen(Number(process.env.PORT ?? 3200), '127.0.0.1', () => console.log('ready')));
