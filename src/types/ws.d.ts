declare module "ws" {
  export type RawData = Buffer | ArrayBuffer | ArrayBufferView | string;

  export class WebSocket {
    readyState: number;
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
    ping(): void;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pong", listener: () => void): this;
  }

  export class WebSocketServer {
    constructor(opts: unknown);
    handleUpgrade(
      req: unknown,
      socket: unknown,
      head: Buffer,
      cb: (ws: WebSocket) => void,
    ): void;
    close(): void;
  }
}
