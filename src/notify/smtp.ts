/* A minimal SMTP client for Cloudflare TCP sockets: STARTTLS, AUTH PLAIN,
   one message, QUIT. It sends through OCI Email Delivery's SMTP relay with
   the same credentials ts-auth uses. */

/** The part of a Cloudflare socket the client uses. */
export interface Socket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): Socket;
  close(): Promise<void>;
}

export type Connect = (address: { hostname: string; port: number }, options: { secureTransport: "starttls" }) => Socket;

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface Mail {
  from: string;
  to: string;
  /** The full RFC 5322 message, headers and body, with CRLF line ends. */
  data: string;
}

export class SmtpError extends Error {}

/** Reads SMTP replies line by line across chunk boundaries. */
class Replies {
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async line(): Promise<string> {
    while (!this.buffer.includes("\r\n")) {
      const { done, value } = await this.reader.read();
      if (done) throw new SmtpError("Connection closed");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    const end = this.buffer.indexOf("\r\n");
    const line = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 2);
    return line;
  }

  /** A whole (possibly multi-line) reply; throws unless its code is expected. */
  async expect(...codes: number[]): Promise<string> {
    const lines: string[] = [];
    let line: string;
    do {
      line = await this.line();
      lines.push(line);
    } while (line[3] === "-");
    const code = Number(line.slice(0, 3));
    if (!codes.includes(code)) throw new SmtpError(`SMTP ${lines.join(" | ")}`);
    return lines.join("\n");
  }

  release(): void {
    this.reader.releaseLock();
  }
}

/** Dot-stuffs the message and terminates it for DATA. */
export function dataBlock(data: string): string {
  const body = data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return `${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

export async function send(
  connect: Connect,
  config: SmtpConfig,
  mail: Mail,
  hello = "status.terrascale.tech",
): Promise<void> {
  let socket = connect({ hostname: config.host, port: config.port }, { secureTransport: "starttls" });
  let replies = new Replies(socket.readable);
  let writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const say = (line: string) => writer.write(encoder.encode(`${line}\r\n`));
  try {
    await replies.expect(220);
    await say(`EHLO ${hello}`);
    await replies.expect(250);
    await say("STARTTLS");
    await replies.expect(220);
    replies.release();
    writer.releaseLock();
    socket = socket.startTls();
    replies = new Replies(socket.readable);
    writer = socket.writable.getWriter();

    await say(`EHLO ${hello}`);
    await replies.expect(250);
    await say(`AUTH PLAIN ${btoa(`\u0000${config.username}\u0000${config.password}`)}`);
    await replies.expect(235);
    await say(`MAIL FROM:<${mail.from}>`);
    await replies.expect(250);
    await say(`RCPT TO:<${mail.to}>`);
    await replies.expect(250, 251);
    await say("DATA");
    await replies.expect(354);
    await writer.write(encoder.encode(dataBlock(mail.data)));
    await replies.expect(250);
    await say("QUIT");
    await replies.expect(221).catch(() => "");
  } finally {
    await socket.close().catch(() => {});
  }
}
