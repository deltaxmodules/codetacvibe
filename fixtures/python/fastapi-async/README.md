# Exemplo 2: FastAPI async + SQLAlchemy async (aiosqlite) + httpx

`Depends` de sessão (gerador async), `BackgroundTasks` e uma chamada HTTP externa (`EXTERNAL_API_URL`, um servidor local de ensaio, com o cabeçalho `Authorization` de `EXTERNAL_API_TOKEN`).
Ensaio: `node scripts/accept-python.mjs fastapi-async` (cria o `.venv` na primeira vez).
