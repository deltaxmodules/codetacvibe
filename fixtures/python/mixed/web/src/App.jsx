import { useEffect, useState } from 'react';
import { addTask, listTasks } from './api.js';

function TaskForm({ onAdded }) {
  const [title, setTitle] = useState('');
  async function submitTask(event) {
    event.preventDefault();
    await addTask(title);
    setTitle('');
    onAdded();
  }
  return (
    <form onSubmit={submitTask}>
      <input id="titulo" value={title} onChange={event => setTitle(event.target.value)} placeholder="nova tarefa" />
      <button id="adicionar" type="submit">Adicionar</button>
    </form>
  );
}

export function App() {
  const [tasks, setTasks] = useState([]);
  async function refresh() {
    setTasks(await listTasks());
  }
  useEffect(() => { refresh(); }, []);
  return (
    <main>
      <h1>Tarefas</h1>
      <TaskForm onAdded={refresh} />
      <button id="atualizar" onClick={refresh}>Atualizar</button>
      <ul>{tasks.map(task => <li key={task.id}>{task.title}</li>)}</ul>
    </main>
  );
}
