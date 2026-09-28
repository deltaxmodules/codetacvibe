// With the Vite proxy, the API is on the same origin (/api -> FastAPI).
// Without it (VITE_API_URL), the browser calls the API's own origin.
const BASE = import.meta.env.VITE_API_URL ?? '';

export async function listTasks() {
  const response = await fetch(`${BASE}/api/tasks`);
  return response.json();
}

export async function addTask(title) {
  const response = await fetch(`${BASE}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(`estado ${response.status}`);
  return response.json();
}
