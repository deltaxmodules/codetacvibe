// Example 4: Vite + React calling a FastAPI API. With the proxy (the usual
// setup), /api goes to the API through Vite; with SEM_PROXY=1 the page calls
// the API's own origin (VITE_API_URL), and the API allows it with CORS.
const api = `http://127.0.0.1:${process.env.API_PORT ?? 8000}`;

export default {
  server: { proxy: process.env.SEM_PROXY ? undefined : { '/api': { target: api } } },
};
