# Exemplo 4: Vite + React → FastAPI (stack mista)

- `web/`: Vite + React (usa o Vite e o React da raiz do repositório). Com proxy (`/api` → FastAPI), o caso habitual; com `SEM_PROXY=1` e `VITE_API_URL`, a página chama a API diretamente (outra origem, com CORS na API via `FRONTEND_ORIGIN`).
- `api/`: FastAPI + sqlite3. O `.venv` é criado pelo ensaio.

Ensaio no Chrome: `node scripts/accept-browser.mjs fixtures/python/mixed/aceitacao-proxy.json` e `…/aceitacao-sem-proxy.json`.
