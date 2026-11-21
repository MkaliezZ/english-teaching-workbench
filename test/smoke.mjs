import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const api = '/api/v1';

test('build, local sign-in, three classroom tracks and SSE snapshots', { timeout: 60000 }, async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'english-workbench-smoke-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const env = { ...process.env, M0_DATA: data, M0_PORT: String(port), M0_TEST_DROP: '0' };
  let server;
  t.after(async () => {
    if (server?.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(data, { recursive: true, force: true, maxRetries: 3 });
  });

  execFileSync(process.execPath, ['scripts/setup-local.mjs'], { env });
  const ca = await readFile(path.join(data, 'localhost.crt'));
  server = spawn(process.execPath, ['--import', 'tsx', 'server/gateway.ts'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  server.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', chunk => { if (String(chunk).includes('M0 listening')) resolve(); });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Gateway exited (${code}). ${diagnostic}`)));
  });

  let sessionHeaders = {};
  function call(route, { method = 'GET', headers = {}, body, stream = false } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = request(origin + route, { ca, method, headers: { Origin: origin, ...sessionHeaders, ...headers } }, incoming => {
        const chunks = [];
        incoming.on('error', reject);
        incoming.on('data', chunk => {
          chunks.push(chunk);
          if (!stream) return;
          const frame = Buffer.concat(chunks).toString().match(/\nevent: task\.snapshot\ndata: (.+)\n\n/);
          if (frame) {
            resolve({ status: incoming.statusCode, headers: incoming.headers, snapshot: JSON.parse(frame[1]) });
            incoming.destroy();
          }
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error(`Timed out: ${route}`)));
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }
  async function post(route, payload, status, headers = {}) {
    const response = await call(api + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    assert.equal(response.status, status, route);
    return { ...response, json: JSON.parse(response.body) };
  }

  const homepage = await call('/');
  assert.equal(homepage.status, 200);
  const cssPath = homepage.body.toString().match(/href="(\/assets\/[^" ]+\.css)"/)?.[1];
  assert.ok(cssPath);
  const css = await call(cssPath);
  assert.equal(css.status, 200);
  assert.ok(/--wb-bg:\s*#14131a/.test(css.body.toString()), 'Dark theme is served');
  assert.ok(/--wb-bg:\s*#f0edf5/.test(css.body.toString()), 'Light theme is served');

  const accounts = JSON.parse(await readFile(path.join(data, 'accounts.json'), 'utf8'));
  const login = await post('/session', { account: 'teacher', password: accounts.teacher }, 200);
  sessionHeaders = { Cookie: login.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': login.json.csrf_token };
  const material = await readFile('examples/library-club.txt');
  for (const track of ['k12', 'toefl', 'ielts']) {
    const { json: project } = await post('/projects', { module: 'classroom', title: `Library Club · ${track}`, track }, 201);
    const form = new FormData();
    form.set('file', new Blob([material], { type: 'text/plain' }), 'library-club.txt');
    const multipart = new Response(form);
    const upload = await call(`${api}/assets?project_id=${project.id}`, {
      method: 'POST', headers: { 'Content-Type': multipart.headers.get('content-type') }, body: Buffer.from(await multipart.arrayBuffer()),
    });
    assert.equal(upload.status, 201, track);
    const { json: task } = await post('/tasks', {
      module: 'classroom', action: 'generate_lesson', project_id: project.id, input: { track },
      asset_ids: [JSON.parse(upload.body).asset_id],
    }, 202, { 'Idempotency-Key': randomUUID() });
    const route = `${api}/tasks/${task.task_id}`;
    let current;
    for (let i = 0; i < 100; i++) {
      const result = await call(route);
      assert.equal(result.status, 200);
      current = JSON.parse(result.body);
      if (['succeeded', 'failed', 'interrupted'].includes(current.status)) break;
      await delay(160);
    }
    assert.equal(current.status, 'succeeded', `${track}: ${current.summary}\n${diagnostic}`);
    const event = await call(`${route}/events`, { headers: { 'Last-Event-ID': '1' }, stream: true });
    assert.match(event.headers['content-type'], /text\/event-stream/);
    assert.deepEqual(event.snapshot, current);
    const artifact = `${api}/artifacts/${current.artifact_ids[0]}`;
    const preview = await call(`${artifact}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.body.toString(), /the courtyard on Thursday/);
    assert.match(preview.headers['content-security-policy'], /sandbox/);
    const pptx = await call(`${artifact}/download?format=pptx`);
    assert.equal(pptx.status, 200);
    assert.equal(pptx.body.subarray(0, 4).toString('hex'), '504b0304');
  }
});
