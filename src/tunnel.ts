// `rivtor db connect`: a localhost TCP listener; every client connection is carried over its own
// authenticated WebSocket to GET /v1/projects/<slug>/db/tunnel, which pipes it to the project's
// Postgres. Uses Node's built-in WebSocket client (Node 22+).
import net from "node:net";

export const DEFAULT_DB_PORT = 54329;

export interface TunnelOptions {
  apiUrl: string;
  token: string;
  slug: string;
  port: number;
  host?: string;
  userAgent?: string;
  onError?: (message: string) => void;
}

type WsCtor = new (
  url: string,
  opts?: { headers?: Record<string, string> },
) => WebSocket;

export function tunnelUrl(apiUrl: string, slug: string): string {
  const u = new URL(
    `${apiUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(slug)}/db/tunnel`,
  );
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

export function webSocketAvailable(): boolean {
  return (
    typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function"
  );
}

/** Starts the local listener; resolves once it is listening. */
export async function startDbTunnel(o: TunnelOptions): Promise<net.Server> {
  const WS = (globalThis as unknown as { WebSocket: WsCtor }).WebSocket;
  const url = tunnelUrl(o.apiUrl, o.slug);
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    const ws = new WS(url, {
      headers: {
        authorization: `Bearer ${o.token}`,
        ...(o.userAgent ? { "user-agent": o.userAgent } : {}),
      },
    });
    ws.binaryType = "arraybuffer";
    const queued: Buffer[] = [];
    let opened = false;
    sock.on("data", (chunk: Buffer) => {
      if (opened && ws.readyState === 1) ws.send(chunk);
      else queued.push(chunk);
    });
    ws.onopen = () => {
      opened = true;
      for (const c of queued.splice(0)) ws.send(c);
    };
    ws.onmessage = (e: MessageEvent) => {
      sock.write(Buffer.from(e.data as ArrayBuffer));
    };
    ws.onclose = () => sock.end();
    ws.onerror = () => {
      if (!opened)
        o.onError?.(
          "The tunnel was refused (check the token's scope and project, or run `rivtor db url` to see the error).",
        );
      sock.destroy();
    };
    const close = () => {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close();
    };
    sock.on("end", close);
    sock.on("error", close);
    sock.on("close", close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve());
  });
  return server;
}

/** The temporary connection string, pointed at the local tunnel instead of the database's own address. */
export function localConnectionString(url: string, port: number): string {
  const u = new URL(url);
  u.hostname = "localhost";
  u.port = String(port);
  return u.toString();
}
