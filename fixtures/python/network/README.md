# Rede, IA, S3, email e ficheiros (Etapa 7)

Uma rota por cliente: SDK `openai` (async, também em streaming) e `anthropic` (sync), `requests`, `urllib`, `aiohttp`, `boto3` (envio para S3 e URL pré-assinado lido com `requests`), `smtplib` e escrita de ficheiros (`open` e `pathlib`).
Os serviços externos são servidores locais de ensaio, criados pelo `node scripts/accept-python.mjs rede` (`AI_BASE_URL`, `EXTERNAL_API_URL`, `S3_ENDPOINT`, `SMTP_HOST`/`SMTP_PORT`, `EXPORT_DIR`).
