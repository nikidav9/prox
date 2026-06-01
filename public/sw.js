const DB_NAME = 'dev-office-v1';
const STORE = 'tasks';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllTasks(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putTask(db, task) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(task);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function processPendingTasks() {
  const db = await openDB();
  const tasks = await getAllTasks(db);
  const pending = tasks.filter(t => t.status === 'pending');
  for (const task of pending) {
    await putTask(db, { ...task, status: 'processing' });
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: task.message,
          agentId: task.agentId,
          history: task.history || [],
          githubToken: task.githubToken || '',
        }),
      });
      const data = await res.json();
      await putTask(db, { ...task, status: 'done', result: data, completedAt: Date.now() });
      // Notify clients
      const clients = await self.clients.matchAll();
      for (const client of clients) {
        client.postMessage({ type: 'TASK_DONE', taskId: task.id, result: data, agentId: task.agentId });
      }
    } catch (err) {
      await putTask(db, { ...task, status: 'error', error: String(err) });
    }
  }
}

self.addEventListener('sync', event => {
  if (event.tag === 'process-tasks') {
    event.waitUntil(processPendingTasks());
  }
});

self.addEventListener('message', event => {
  if (event.data?.type === 'PROCESS_NOW') {
    processPendingTasks();
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
