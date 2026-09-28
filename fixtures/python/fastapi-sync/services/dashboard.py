import asyncio


async def load_dashboard():
    sales, stock, alerts = await asyncio.gather(load_sales(), load_stock(), load_alerts())
    return {'sales': sales, 'stock': stock, 'alerts': alerts}


async def load_sales():
    await asyncio.sleep(0.03)
    return sum_values([10, 20, 30])


async def load_stock():
    await asyncio.sleep(0.01)
    return sum_values([1, 2])


async def load_alerts():
    await asyncio.sleep(0.02)
    return count_alerts(['a', 'b'])


def sum_values(values):
    return sum(values)


def count_alerts(alerts):
    return len(alerts)
