// Página de exemplo: um clique que faz dois pedidos, um só de ecrã, e uma
// página nova que pede dados ao carregar (continua a ação da navegação).
async function reloadList() {
  const response = await fetch('/api/notas');
  const notes = await response.json();
  document.getElementById('lista').innerHTML = notes.map(note => `<li>${note}</li>`).join('');
}
async function saveNote() {
  document.getElementById('estado').textContent = 'a guardar…';
  await fetch('/api/notas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'nota de ensaio' }) });
  await reloadList();
  document.getElementById('estado').textContent = 'guardada';
}
function toggleDetails() {
  const details = document.getElementById('detalhes');
  details.hidden = !details.hidden;
}
function countVisit() {
  const request = new XMLHttpRequest();
  request.open('GET', '/api/visitas');
  request.send();
}
document.getElementById('guardar').addEventListener('click', saveNote);
document.getElementById('alternar').addEventListener('click', toggleDetails);
if (location.pathname === '/outra') countVisit();
