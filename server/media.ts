import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const MAX_CALLS = 12;
const MAX_TOKENS = 4096;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function startMedia(root: string, home: string) {
  const { createApp } = await import(pathToFileURL(path.join(root, 'server/app.ts')).href);
  const { Config } = await import(pathToFileURL(path.join(root, 'server/config.ts')).href);
  const originalHome = path.join(root, '.local');
  const original = new Config(existsSync(path.join(originalHome, 'credential-key.bin')) ? originalHome : path.join(home, 'config'));
  await original.init();
  const key = original.key();
  const settings = original.public();
  if (!key) throw new Error('MEDIA_KEY_MISSING');
  const upstream = new URL(settings.baseUrl);
  if (upstream.protocol !== 'https:' || upstream.hostname !== 'api.deepseek.com') throw new Error('MEDIA_ENDPOINT_UNVERIFIED');
  upstream.pathname = `${upstream.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/messages`;
  await mkdir(home, { recursive: true });
  const meterPath = path.join(home, 'm0-meter.json');
  const meter: { model: string; used: number; http_statuses: number[]; reported_usage?: unknown } = await readFile(meterPath, 'utf8')
    .then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return { model: settings.model, used: 0, http_statuses: [] };
    });
  const save = () => writeFile(meterPath, JSON.stringify(meter, null, 2));
  const relay = http.createServer(async (request, response) => {
    const reject = (status: number) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      type: 'error', error: { type: 'api_error', message: 'M0 provider request unavailable.' },
    }));
    if (!request.url?.endsWith('/messages') || request.method !== 'POST') { reject(404); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (meter.used >= MAX_CALLS) { reject(400); return; }
      meter.used++;
      await save();
      body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
      const result = await fetch(upstream, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      meter.http_statuses.push(result.status);
      await save();
      response.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') ?? 'application/json' });
      if (result.body) {
        const stream = Readable.fromWeb(result.body as never);
        response.on('close', () => stream.destroy());
        stream.pipe(response);
        await finished(response);
      } else response.end();
    } catch { if (response.headersSent) response.destroy(); else reject(502); }
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const instance = await createApp({ root, home: path.join(home, 'bot') });
  await instance.config.save({
    model: settings.model, maxTokens: MAX_TOKENS, vision: false, apiKey: 'm0-local-relay',
    baseUrl: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    workbenchRoot: settings.workbenchRoot, python: settings.python,
  });
  const base = await instance.app.listen({ host: '127.0.0.1', port: 0 });
  instance.setOrigin(base);
  const session = await fetch(`${base}/api/bootstrap`);
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const { csrfToken } = await session.json();
  async function call(route: string, data?: object) {
    const response = await fetch(`${base}${route}`, {
      method: data ? 'POST' : 'GET', signal: AbortSignal.timeout(95000),
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!response.ok) {
      const diagnostic = await response.json().catch(() => ({}));
      throw new Error(`MEDIA_HTTP_${response.status}_${typeof diagnostic.code === 'string' ? diagnostic.code : 'UNKNOWN'}`);
    }
    return response.json();
  }
  const links = path.join(home, 'links');
  await mkdir(links, { recursive: true });
  type Link = { projectId: string; taskId: string };
  function terminalResult(result: any, taskId: string) {
    const task = result.project.tasks.find((candidate: { id: string }) => candidate.id === taskId);
    if (!task || ['pending', 'running'].includes(task.status)) return;
    if (!['done', 'failed', 'interrupted'].includes(task.status)) throw new Error(`MEDIA_${task.status.toUpperCase()}`);
    const script = result.artifacts.find((item: { type: string; current: boolean }) => item.type === 'script' && item.current);
    if (!script?.payload?.segments?.length) throw new Error('MEDIA_MISSING_SAVED_SCRIPT');
    return { script, savedAfterUpstreamFailure: task.status !== 'done', usage: task.usage ?? null,
      upstream_status: task.status, upstream_artifact: script.id, upstream_project: result.project.id, upstream_task: taskId };
  }
  async function resultFor(link: Link, gatewayTask: string) {
    const result = terminalResult(await call(`/api/projects/${link.projectId}`), link.taskId);
    if (result) {
      meter.reported_usage = result.usage;
      await save();
      const { script, ...provenance } = result;
      await writeFile(path.join(links, `${gatewayTask}.result.json`), JSON.stringify(provenance, null, 2));
      return result;
    }
  }
  return {
    async run(title: string, prompt: string, gatewayTask: string) {
      const { projectId, taskId } = await call('/api/tasks', { intent: 'script', uploadIds: [], title, prompt });
      const link = { projectId, taskId };
      await writeFile(path.join(links, `${gatewayTask}.json`), JSON.stringify(link), { flag: 'wx' });
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const result = await resultFor(link, gatewayTask);
        if (result) return result;
        await wait(500);
      }
      throw new Error('MEDIA_TIMEOUT');
    },
    async recover(prior: string, next: string) {
      const link = JSON.parse(await readFile(path.join(links, `${prior}.json`), 'utf8')) as Link;
      const result = await resultFor(link, next);
      if (!result) throw new Error('MEDIA_NOT_TERMINAL');
      return result;
    },
    async close() {
      await instance.app.close();
      relay.closeAllConnections();
      await new Promise<void>(resolve => relay.close(() => resolve()));
      await instance.wb.stopIfIdle();
    },
  };
}
