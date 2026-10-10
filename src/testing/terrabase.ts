/* Published TerraBase only: verify the release before executing it, provision
   via its APIs, and trust this instance's certificate without weakening TLS. */

import { isId, newId } from "../ids";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import type { CanaryConfig } from "../probe/canary";

export const release = JSON.parse(await readFile(new URL("./terrabase-release.json", import.meta.url), "utf8")) as {
  tag: string;
  sha256: string;
};
export const testRegion = "gru-1";
const execute = promisify(execFile);
const nativeFetch = fetch;

export async function verifiedBinary(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("TerraBase release requires linux/x64");
  const directory = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "terrascale/terrabase",
    release.sha256,
  );
  const binary = process.env.TERRABASE_BINARY ?? join(directory, "terrabase-linux-amd64");
  const verify = async (path: string) => {
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (digest !== release.sha256) throw new Error(`TerraBase ${release.tag}: SHA256 mismatch (${digest})`);
  };
  try {
    await verify(binary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.env.TERRABASE_BINARY) throw error;
    await mkdir(directory, { recursive: true });
    const download = `${binary}.${newId()}.download`;
    try {
      if (process.env.FORGEJO_READ_TOKEN) {
        // curl keeps credentials off redirects to another host. Pass the token
        // on stdin so it never appears in the child process's argument list.
        const child = spawn("curl", [
          "--fail",
          "--silent",
          "--show-error",
          "--location",
          "--connect-timeout",
          "15",
          "--max-time",
          "120",
          "--config",
          "-",
          "--output",
          download,
          `https://git.terrascale.tech/TerraScale/terrabase/releases/download/${release.tag}/terrabase-linux-amd64`,
        ]);
        child.stdin.end(`header = "Authorization: token ${process.env.FORGEJO_READ_TOKEN}"\n`);
        const [code] = await once(child, "close");
        if (code !== 0) throw new Error(`TerraBase release download failed (curl ${code})`);
      } else {
        await execute(
          "fj",
          [
            "release",
            "asset",
            "download",
            "--repo",
            "TerraScale/terrabase",
            release.tag,
            "terrabase-linux-amd64",
            "--output",
            download,
          ],
          { timeout: 120_000 },
        );
      }
      await verify(download);
      await chmod(download, 0o700);
      await rename(download, binary);
    } finally {
      await rm(download, { force: true });
    }
  }
  await chmod(binary, 0o700);
  return binary;
}

export async function startTerraBase() {
  const binary = await verifiedBinary();
  const directory = await mkdtemp(join(tmpdir(), "ts-status-terrabase-"));
  const credential = Buffer.from(randomBytes(32)).toString("hex");
  const userId = newId();
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let launchError: Error | undefined;
  const stop = async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child?.kill("SIGKILL"), 3_000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const certificate = join(directory, "client.pem");
    const privateKey = join(directory, "client.key");
    const credentialFile = join(directory, "credential");
    await execute("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      privateKey,
      "-out",
      certificate,
    ]);
    await writeFile(credentialFile, credential, { mode: 0o600 });
    const ca = await readFile(certificate);
    // Never inherit an operator's TerraBase settings into this disposable instance.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("TERRABASE_") && name !== "FORGEJO_READ_TOKEN"),
    );
    child = spawn(
      binary,
      [
        "--admin-port=0",
        "--client-port=0",
        `--region=${testRegion}`,
        `--data-directory=${join(directory, "data")}`,
        `--client-certificate=${certificate}`,
        `--client-private-key=${privateKey}`,
        `--management-credential-file=${credentialFile}`,
      ],
      { env },
    );
    child.once("error", (error: Error) => {
      launchError = error;
    });
    closed = new Promise((resolve) => child!.once("close", () => resolve()));
    let logs = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    const deadline = Date.now() + 15_000;
    let admin = "";
    let origin = "";
    while (!admin || !origin) {
      admin = /Now listening on: (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1] ?? "";
      const port = /Now listening on: https:\/\/[^\s]+:(\d+)/.exec(logs)?.[1];
      origin = port ? `https://127.0.0.1:${port}` : "";
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
        throw new Error(`TerraBase startup failed: ${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (new URL(url).origin !== origin) throw new Error(`Test fetch escaped local TerraBase: ${url}`);
      return await new Promise<Response>((resolve, reject) => {
        const req = request(
          url,
          {
            method: init.method,
            headers: Object.fromEntries(new Headers(init.headers)),
            ca,
            signal: init.signal ?? undefined,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
              try {
                resolve(
                  new Response([204, 205, 304].includes(response.statusCode!) ? null : Buffer.concat(chunks), {
                    status: response.statusCode,
                    headers: Object.fromEntries(
                      Object.entries(response.headers).flatMap(([name, value]) =>
                        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
                      ),
                    ),
                  }),
                );
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on("error", reject);
        req.end(init.body);
      });
    }) as typeof fetch;
    const managementHeaders = (organization?: string) => ({
      authorization: `Bearer ${credential}`,
      "X-TerraBase-User-Id": userId,
      ...(organization ? { "X-TerraBase-Organization-Id": organization } : {}),
    });
    const create = async (url: string, body: unknown, headers: Record<string, string>, adminRequest = false) => {
      const response = await (adminRequest ? nativeFetch : fetcher)(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status !== 201)
        throw new Error(`Provision ${new URL(url).pathname}: HTTP ${response.status} ${await response.text()}`);
      return (await response.json()) as { id: string; secret: string };
    };
    // Management routes exist only on the admin listener; the client origin answers 401 invalid_key.
    const organization = (
      await create(`${admin}/v1/management/organizations`, { name: "Status test" }, managementHeaders(), true)
    ).id;
    if (!isId(organization))
      throw new Error(
        "TerraBase release returns legacy organization IDs; publish a release implementing TS-754 before running the integration suite.",
      );
    const projectsPath = `${admin}/v1/management/organizations/${organization}/projects`;
    const project = (await create(projectsPath, { name: "Canary" }, managementHeaders(organization), true)).id;
    if (!isId(project))
      throw new Error(
        "TerraBase release returns legacy project IDs; publish a release implementing TS-754 before running the integration suite.",
      );
    const database = "status_canary";
    const createDatabase = async (name: string) =>
      (await create(`${projectsPath}/${project}/databases`, { name }, managementHeaders(organization), true)).id;
    const databaseId = await createDatabase(database);
    const issueKey = async (scopes: string[]) =>
      (
        await create(
          `${admin}/admin/api-keys`,
          {
            name: "Status test",
            scopes,
            organizationId: organization,
            projectId: project,
            databaseId,
          },
          {},
          true,
        )
      ).secret;
    const key = await issueKey(["documents:read", "documents:write"]);
    const collection = "canary";
    await create(
      `${origin}/v1/projects/${project}/databases/${database}/collections`,
      { name: collection },
      { authorization: `Bearer ${key}` },
    );
    const canary: CanaryConfig = { origin, project, database, collection, document: newId(), key };
    return {
      origin,
      admin,
      fetcher,
      canary,
      issueKey,
      createDatabase,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
