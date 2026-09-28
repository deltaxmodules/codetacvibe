# Exemplo 3: FastAPI com endpoints `def` (threadpool), `asyncio.gather` e um websocket

Ensaio: `node scripts/accept-python.mjs fastapi-sync` (cria o `.venv` na primeira vez).

Inclui também o exemplo 5, a rota de CPU (`/cpu?count=500`: 1.000+ chamadas de funções curtas por pedido), usada na medição de custo (`node scripts/benchmark-python.mjs`).
