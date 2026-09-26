import { describe, expect, it } from "vitest";
import { dataBlock, send, SmtpError, type Socket } from "./smtp";

/** A scripted SMTP server: answers each command with the next reply. */
function server(replies: Record<string, string>, greeting = "220 smtp.test ready\r\n") {
  const log: string[] = [];
  let tls = false;
  const socket = (): Socket => {
    let push: (text: string) => void = () => {};
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        if (!tls) push(greeting);
      },
    });
    let data = false;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = new TextDecoder().decode(chunk);
        if (data) {
          log.push(`[data ${text.length}]`);
          data = false;
          // Answer in two chunks to exercise line buffering.
          push("250 ");
          push("queued\r\n");
          return;
        }
        const command = text.trim();
        log.push(`${tls ? "tls " : ""}${command.startsWith("AUTH") ? "AUTH PLAIN …" : command}`);
        const verb = command.split(" ")[0] ?? "";
        if (verb === "DATA") data = true;
        push(replies[verb] ?? "500 unknown\r\n");
      },
    });
    return {
      readable,
      writable,
      startTls: () => {
        tls = true;
        return socket();
      },
      close: async () => {},
    };
  };
  return { log, connect: () => socket() };
}

const OK = {
  EHLO: "250-smtp.test\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n",
  STARTTLS: "220 go ahead\r\n",
  AUTH: "235 ok\r\n",
  MAIL: "250 ok\r\n",
  RCPT: "250 ok\r\n",
  DATA: "354 go\r\n",
  QUIT: "221 bye\r\n",
};

const config = { host: "smtp.test", port: 587, username: "user@oci", password: "secret" };
const mail = { from: "noreply@terrascale.tech", to: "a@example.com", data: "Subject: Hi\r\n\r\n.hidden\r\nbody" };

describe("smtp", () => {
  it("upgrades to TLS before authenticating and sends one message", async () => {
    const { log, connect } = server(OK);
    await send(connect, config, mail);
    expect(log).toEqual([
      "EHLO status.terrascale.tech",
      "STARTTLS",
      "tls EHLO status.terrascale.tech",
      "tls AUTH PLAIN …",
      "tls MAIL FROM:<noreply@terrascale.tech>",
      "tls RCPT TO:<a@example.com>",
      "tls DATA",
      expect.stringMatching(/^\[data \d+\]$/),
      "tls QUIT",
    ]);
  });

  it("fails on a rejected step", async () => {
    const { connect } = server({ ...OK, AUTH: "535 bad credentials\r\n" });
    await expect(send(connect, config, mail)).rejects.toThrow(SmtpError);
  });

  it("dot-stuffs and terminates message data", () => {
    expect(dataBlock("a\n.b\r\n")).toBe("a\r\n..b\r\n.\r\n");
  });
});
