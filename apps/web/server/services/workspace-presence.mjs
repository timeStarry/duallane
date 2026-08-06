export function createWorkspacePresence() {
  const connectionsByUser = new Map();

  function register(userId, socket) {
    if (!userId || !socket) return () => {};
    let connections = connectionsByUser.get(userId);
    if (!connections) {
      connections = new Set();
      connectionsByUser.set(userId, connections);
    }
    connections.add(socket);
    return () => {
      const current = connectionsByUser.get(userId);
      current?.delete(socket);
      if (current?.size === 0) connectionsByUser.delete(userId);
    };
  }

  function isOnline(userId) {
    const connections = connectionsByUser.get(userId);
    if (!connections) return false;
    for (const socket of connections) {
      if (socket.readyState === 1) return true;
    }
    return false;
  }

  return { isOnline, register };
}
