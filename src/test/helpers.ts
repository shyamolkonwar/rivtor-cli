import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { list as tarList } from "tar";

export async function makeTree(files: Record<string, string>, name = "proj"): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "rivtor-test-"));
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return root;
}

export async function tarEntries(data: Uint8Array): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "rivtor-tar-"));
  const file = join(dir, "t.tar.gz");
  await writeFile(file, data);
  const names: string[] = [];
  await tarList({ file, onReadEntry: (e) => void names.push(e.path) });
  return names.sort();
}

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Builds a fake fetch from a route handler; records every request. */
export function mockFetch(handler: (req: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = async (input: string | URL, init: RequestInit = {}) => {
    const req: Recorded = {
      method: init.method ?? "GET",
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    };
    calls.push(req);
    return handler(req);
  };
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
