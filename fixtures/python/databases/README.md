# Drivers de base de dados (Etapa 6)

Uma rota por biblioteca: psycopg (sync e async), psycopg2, PyMySQL, asyncpg, SQLAlchemy sobre psycopg e sobre asyncpg, e SQLModel sobre sqlite.
Cada rota insere, lê, tenta alterar uma linha que não existe e apaga.
O Postgres e o MySQL são contentores Docker de ensaio, criados e apagados pelo `node scripts/accept-python.mjs bases-de-dados` (`PG_DSN`, `MYSQL_*`).
