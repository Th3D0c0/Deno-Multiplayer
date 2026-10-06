interface Player {
  id: string;
  x: number;
  y: number;
}

const players: Record<string, Player> = {};
const sockets = new Map<string, WebSocket>();

function broadcast(message: unknown, except?: string) {
  for (const [id, socket] of sockets) {
    if (id !== except) {
      socket.send(JSON.stringify(message));
    }
  }
}

Deno.serve((request) => {
  const { pathname } = new URL(request.url);

  // Static file serving
  if (pathname === "/") {
    return new Response(Deno.readTextFileSync("./public/index.html"), {
      headers: { "content-type": "text/html" },
    });
  }

  if (pathname === "/client.js") {
    return new Response(Deno.readTextFileSync("./public/client.js"), {
      headers: { "content-type": "application/javascript" },
    });
  }

  // WebSocket for game
  if (pathname === "/ws") {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }
    
    const { socket, response } = Deno.upgradeWebSocket(request);
    guardSocket(socket); // comment this line to disable idle/max timeout for testing (careful on Deno Deploy free plan)
    const id = crypto.randomUUID();

    players[id] = { id, x: 100, y: 100 };
    sockets.set(id, socket);

    socket.addEventListener("open", () => {
      console.log(`Player ${id} connected`);
      socket.send(JSON.stringify({ type: "init", id, players }));
      broadcast({ type: "join", player: players[id] }, id);
    });

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "move") {
        const p = players[id];
        if (!p) return;
        if (msg.dir === "up") p.y -= 10;
        if (msg.dir === "down") p.y += 10;
        if (msg.dir === "left") p.x -= 10;
        if (msg.dir === "right") p.x += 10;
        broadcast({ type: "update", player: p });
      }
    });

    socket.addEventListener("close", () => {
      console.log(`Player ${id} disconnected`);
      delete players[id];
      sockets.delete(id);
      broadcast({ type: "leave", id });
    });

    return response;
  }

  return new Response("Not found", { status: 404 });
});


// When using Deno Deploy, the free plan's quota can be conserved by closing sockets that are idle or have been connected for too long
const IDLE_MS = 10 * 60 * 1000;     // close connection after 10 minutes of inactivity
const MAX_MS = 4 * 60 * 60 * 1000;  // close the connection after 4 hours

function guardSocket(socket: WebSocket) {
  let idle: number | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => socket.close(4000, "idle timeout"), IDLE_MS);
  };
  const max = setTimeout(() => socket.close(4001, "max duration"), MAX_MS);

  socket.addEventListener("open", resetIdle);
  socket.addEventListener("message", resetIdle);
  socket.addEventListener("close", () => {
    clearTimeout(idle);
    clearTimeout(max);
  });
}