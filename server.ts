// HTTP server: static files, the /ws websocket endpoint and the socket guard.
// All the game logic lives in game.ts.
import { closeConnection, type Connection, handleMessage, openConnection, startGame } from "./game.ts";

startGame();

Deno.serve((request) => {
  const { pathname } = new URL(request.url);

  // Static file serving
  if (pathname === "/") {
    return new Response(Deno.readTextFileSync("./public/index.html"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (pathname === "/client.js") {
    return new Response(Deno.readTextFileSync("./public/client.js"), {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  // WebSocket for game
  if (pathname === "/ws") {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }

    const { socket, response } = Deno.upgradeWebSocket(request);
    guardSocket(socket); // comment this line to disable idle/max timeout for testing (careful on Deno Deploy free plan)

    // the connection is a spectator until it sends a "join" message
    let conn: Connection | null = null;

    socket.addEventListener("open", () => {
      conn = openConnection(socket);
    });

    socket.addEventListener("message", (event) => {
      if (conn) handleMessage(conn, event.data);
    });

    socket.addEventListener("close", () => {
      if (conn) closeConnection(conn);
      conn = null;
    });

    socket.addEventListener("error", () => {
      // a close event follows, nothing to do here
    });

    return response;
  }

  return new Response("Not found", { status: 404 });
});

// When using Deno Deploy, the free plan's quota can be conserved by closing sockets that are idle or have been connected for too long
const IDLE_MS = 10 * 60 * 1000; // close connection after 10 minutes of inactivity
const MAX_MS = 4 * 60 * 60 * 1000; // close the connection after 4 hours

function guardSocket(socket: WebSocket) {
  let idle: ReturnType<typeof setTimeout> | undefined;
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
