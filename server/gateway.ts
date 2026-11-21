import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, request as forward } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { startMedia } from './media.js';
import { materialExtension, maxMaterialBytes } from '../shared/materials.js';
import type { MaterialExtension } from '../shared/materials.js';
import { matchesMaterialHeader } from './material-upload.js';
import type { FastifyRequest } from 'fastify';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = path.resolve(process.env.M0_DATA || path.join(root, '.m0-data'));
const web = path.join(root, 'dist', 'web');
const qaEnabled = process.env.M0_TEST_DROP === '1';
const upstreamRoot = process.env.M0_BOT_ROOT;
const originPort = Number(process.env.M0_PORT || 8443);
const origin = `https://127.0.0.1:${originPort}`;
const execute = promisify(execFile);
const random = () => randomBytes(32).toString('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isEqual = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
await mkdir(path.join(data, 'assets'), { recursive: true });
const accounts = ['teacher', 'reviewer'] as const;
const credentials = await readFile(path.join(data, 'accounts.json'), 'utf8').then(JSON.parse).catch(async error => {
  if (error.code !== 'ENOENT') throw error;
  const generated = Object.fromEntries(accounts.map(name => [name, random()]));
  await writeFile(path.join(data, 'accounts.json'), JSON.stringify(generated), { flag: 'wx', mode: 0o600 });
  return generated;
});

const db = new DatabaseSync(path.join(data, 'm0.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, module TEXT NOT NULL, title TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id));
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL REFERENCES projects(id),
    idem TEXT NOT NULL, digest TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(owner, idem));
  CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), card TEXT NOT NULL);`);
for (const [table, column, statement] of [
  ['projects', 'track', 'ALTER TABLE projects ADD COLUMN track TEXT'],
  ['assets', 'extension', "ALTER TABLE assets ADD COLUMN extension TEXT NOT NULL DEFAULT '.pdf'"],
  ['assets', 'filename', "ALTER TABLE assets ADD COLUMN filename TEXT NOT NULL DEFAULT '已上传材料.pdf'"],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(info => info.name === column)) db.exec(statement);
}
db.exec(`CREATE INDEX IF NOT EXISTS tasks_project_owner ON tasks(project, owner);
  CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task);`);
type Snapshot = { task_id: string; revision: number; status: string; title: string; summary: string; artifact_ids: string[]; next_action: string | null };
type Session = { token: string; csrf: string; owner: string; expires: number };
type Track = 'k12' | 'toefl' | 'ielts';
type Project = { id: string; owner: string; module: 'media' | 'classroom'; title: string; track?: Track | null };
type Asset = { id: string; extension: MaterialExtension; filename: string };
type TaskRow = { id: string; project: string; snapshot: string; digest: string };
type Subscriber = { session: Session; response: ServerResponse };
const sessions = new Map<string, Session>();
const streams = new Map<string, Set<Subscriber>>();
const jobs = new Set<Promise<void>>();
const snap = (row: TaskRow): Snapshot => JSON.parse(row.snapshot);
const getTask = (id: string, owner: string) => db.prepare('SELECT id, project, snapshot, digest FROM tasks WHERE id=? AND owner=?').get(id, owner) as TaskRow | undefined;
for (const row of db.prepare('SELECT id, project, snapshot, digest FROM tasks').all() as TaskRow[]) {
  const last = snap(row);
  if (['queued', 'running'].includes(last.status)) {
    const interrupted = { ...last, revision: last.revision + 1, status: 'interrupted', summary: '服务重启，执行已中断。', next_action: 'retry' };
    db.prepare('UPDATE tasks SET snapshot=? WHERE id=?').run(JSON.stringify(interrupted), row.id);
  }
}

class PublicError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
function auth(request: FastifyRequest) {
  const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('m0_session='))?.slice('m0_session='.length);
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expires <= Date.now()) throw new PublicError(401, '请重新登录。');
  if (request.method === 'POST' && (!isEqual(request.headers['x-csrf-token'], session.csrf) || request.headers.origin !== origin)) throw new PublicError(403, '请求校验失败。');
  return session;
}
function projectFor(id: string, owner: string) {
  const project = db.prepare(`SELECT p.id,p.owner,p.module,p.title,COALESCE(p.track,(
    SELECT json_extract(a.card,'$.track') FROM tasks t JOIN artifacts a ON a.task=t.id
    WHERE t.project=p.id AND t.owner=p.owner AND json_extract(a.card,'$.kind')='lesson' ORDER BY t.rowid DESC LIMIT 1
  )) AS track FROM projects p WHERE p.id=? AND p.owner=?`).get(id, owner) as Project | undefined;
  if (!project) throw new PublicError(404, '项目不可用。');
  return project;
}
function taskFor(id: string, session: Session) {
  const row = getTask(id, session.owner);
  if (!row) throw new PublicError(404, '任务不可用。');
  return row;
}
function sendSnapshot(client: Subscriber, snapshot: Snapshot) {
  if (sessions.get(client.session.token) !== client.session || client.session.expires <= Date.now()) {
    client.response.end();
    return;
  }
  if (!client.response.destroyed && !client.response.writableEnded) {
    client.response.write(`id: ${snapshot.revision}\nevent: task.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }
}
function setSnapshot(snapshot: Snapshot, status: string, summary: string, artifacts: string[] = [], nextAction: string | null = null) {
  const next: Snapshot = { task_id: snapshot.task_id, revision: snapshot.revision + 1, status, title: snapshot.title,
    summary, artifact_ids: artifacts, next_action: nextAction };
  db.prepare('UPDATE tasks SET snapshot=? WHERE id=?').run(JSON.stringify(next), next.task_id);
  for (const subscriber of streams.get(next.task_id) ?? []) sendSnapshot(subscriber, next);
  return next;
}

const moduleID = z.enum(['media', 'classroom']);
const trackID = z.enum(['k12', 'toefl', 'ielts']);
const mediaInput = z.object({ prompt: z.string().trim().min(12).max(3000) }).strict();
const classroomInput = z.object({ track: trackID, pages: z.string().regex(/^[1-9]\d{0,2}-[1-9]\d{0,2}$/).optional(), goal: z.string().trim().max(300).optional() }).strict();
const taskInput = z.discriminatedUnion('action', [
  z.object({ module: z.literal('media'), action: z.literal('draft_script'), project_id: z.string().uuid(), input: mediaInput, asset_ids: z.tuple([]) }).strict(),
  z.object({ module: z.literal('media'), action: z.literal('recover_script'), project_id: z.string().uuid(), input: z.object({ prior_task_id: z.string().uuid() }).strict(), asset_ids: z.tuple([]) }).strict(),
  z.object({ module: z.literal('classroom'), action: z.literal('generate_lesson'), project_id: z.string().uuid(), input: classroomInput, asset_ids: z.tuple([z.string().uuid()]) }).strict(),
]);
type TaskInput = z.infer<typeof taskInput>;
let media: Awaited<ReturnType<typeof startMedia>> | undefined;
let mediaStartup: Promise<Awaited<ReturnType<typeof startMedia>>> | undefined;
function mediaForTask() {
  if (!upstreamRoot) throw new Error('MEDIA_UPSTREAM_MISSING');
  return mediaStartup ??= startMedia(upstreamRoot, path.join(data, 'media')).then(service => (media = service));
}
const validateLesson = z.object({ title: z.string(), objective: z.string(), source: z.string(), pages: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), activities: z.number().int().positive(), slides: z.number().int().positive() }).strict();
const previewPath = (id: string, file: string) => path.join(data, 'artifacts', id, file);
const materialErrors: Record<string, string> = {
  MATERIAL_RANGE: '选页范围无效。请核对页数，单次最多选 20 页。',
  MATERIAL_EMPTY: '没有读到可用文字。可改传带文本的文档，或上传要讲解的页面截图。',
  MATERIAL_INVALID: '材料内容无法读取。请检查文件是否完整、格式是否与扩展名一致。',
};
async function runTask(snapshot: Snapshot, input: TaskInput, asset?: Asset) {
  const running = setSnapshot(snapshot, 'running', input.module === 'media' ? '正在准备口播稿。' : '正在核对教材并生成课堂包。');
  if (qaEnabled && input.action === 'generate_lesson') await delay(1500);
  const artifactId = randomUUID();
  try {
    let card: object;
    let summary = '互动 HTML 与可编辑 PPTX 已生成。';
    if (input.module === 'media') {
      const engine = await mediaForTask();
      const result = input.action === 'recover_script' ? await engine.recover(input.input.prior_task_id, snapshot.task_id)
        : await engine.run(snapshot.title, input.input.prompt, snapshot.task_id);
      const { script } = result;
      const segments = z.array(z.object({ start: z.number(), end: z.number(), spoken: z.string(), visual: z.string(), subtitle: z.string() })).min(1).max(60).parse(script.payload.segments);
      const text = segments.map(segment => `${segment.start}–${segment.end}s\n${segment.spoken}\n画面：${segment.visual}\n字幕：${segment.subtitle}`).join('\n\n');
      await mkdir(previewPath(artifactId, ''), { recursive: true });
      await writeFile(previewPath(artifactId, 'script.txt'), text, 'utf8');
      card = { artifact_id: artifactId, kind: 'script', title: '口播稿', version: 1, review_status: 'needs_review', segments };
      summary = result.savedAfterUpstreamFailure ? '已取回已保存的口播稿，待审阅。' : '口播稿已保存。';
    } else {
      if (!asset) throw new Error('MISSING_TASK_MATERIAL');
      const folder = previewPath(artifactId, '');
      const { stdout } = await execute(process.env.M0_PYTHON || 'python', ['-B', '-X', 'utf8', path.join(root, 'server', 'lesson.py'),
        path.join(data, 'assets', `${asset.id}${asset.extension}`), folder, input.input.track, input.input.pages || 'auto',
        `--filename=${asset.filename}`, `--goal=${input.input.goal || ''}`], { timeout: 90000, windowsHide: true });
      const lesson = validateLesson.parse(JSON.parse(stdout));
      await Promise.all(['lesson.html', 'lesson.pptx'].map(async file => {
        if (!(await stat(path.join(folder, file))).size) throw new Error('EMPTY_ARTIFACT');
      }));
      card = { artifact_id: artifactId, kind: 'lesson', version: 1, review_status: 'needs_review', track: input.input.track,
        title: lesson.title, objective: lesson.objective, source: lesson.source, pages: lesson.pages, activities: lesson.activities, slides: lesson.slides };
    }
    db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(artifactId, snapshot.task_id, JSON.stringify(card));
    setSnapshot(running, 'succeeded', summary, [artifactId], 'open_artifact');
  } catch (error) {
    const code = error instanceof Error && /^MEDIA_[A-Z0-9_]+$/.test(error.message) ? error.message : 'RENDER_OR_PERSIST';
    console.error(JSON.stringify({ task_id: snapshot.task_id, code }));
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const message = typeof stderr === 'string' ? materialErrors[stderr.trim()] : undefined;
    const mediaMessage = code === 'MEDIA_UPSTREAM_MISSING'
      ? '请按 README 配置 self-media-bot 后再生成口播稿。'
      : '出稿暂时未完成，请检查材料后重试。';
    const nextAction = input.action === 'draft_script' && code !== 'MEDIA_UPSTREAM_MISSING' ? 'recover_script'
      : input.module === 'classroom' ? 'retry' : null;
    setSnapshot(running, 'failed', input.module === 'media' ? mediaMessage : message ?? '未能生成课件，请核对材料后重试。', [], nextAction);
  }
}

const app = Fastify({ logger: false });
await app.register(multipart, { limits: { files: 1, fields: 0, fileSize: maxMaterialBytes }, throwFileSizeLimit: false });
app.addHook('onRequest', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof PublicError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: '请检查轨道、素材或任务输入。' });
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: '无法读取请求。' });
  console.error(JSON.stringify({ code: 'GATEWAY_REQUEST_FAILED' }));
  return reply.code(500).send({ error: '服务暂时不可用。' });
});
const prefix = '/api/v1';
app.post(`${prefix}/session`, async (request, reply) => {
  if (request.headers.origin !== origin) throw new PublicError(403, '请求校验失败。');
  const { account, password } = z.object({ account: z.enum(accounts), password: z.string().max(100) }).strict().parse(request.body);
  if (!isEqual(password, credentials[account])) throw new PublicError(401, '登录信息不匹配。');
  const session = { token: random(), csrf: random(), owner: account, expires: Date.now() + 4 * 60 * 60 * 1000 };
  sessions.set(session.token, session);
  reply.header('Set-Cookie', `m0_session=${session.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`);
  return { account, csrf_token: session.csrf };
});
app.post(`${prefix}/session/end`, async (request, reply) => {
  const session = auth(request);
  sessions.delete(session.token);
  for (const clients of streams.values()) for (const client of clients) if (client.session === session) client.response.end();
  return reply.header('Set-Cookie', 'm0_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').code(204).send();
});
app.get(`${prefix}/context`, async request => {
  const session = auth(request);
  return { account: session.owner, csrf_token: session.csrf, organization: 'm0-local', modules: ['media', 'classroom'], classes: [] };
});
app.get(`${prefix}/projects`, async request => {
  const session = auth(request);
  const { module } = z.object({ module: moduleID }).parse(request.query);
  return db.prepare(`SELECT p.id, p.module, p.title, COALESCE(p.track, (
      SELECT json_extract(a.card, '$.track') FROM tasks t JOIN artifacts a ON a.task=t.id
      WHERE t.project=p.id AND t.owner=p.owner AND json_extract(a.card, '$.kind')='lesson' ORDER BY t.rowid DESC LIMIT 1
    )) AS track, (SELECT COUNT(*) FROM tasks WHERE project=p.id AND owner=p.owner) AS task_count
    FROM projects p WHERE p.owner=? AND p.module=? ORDER BY p.rowid DESC`).all(session.owner, module);
});
app.post(`${prefix}/projects`, async (request, reply) => {
  const session = auth(request);
  const { module, title, track } = z.object({ module: moduleID, title: z.string().trim().min(1).max(100), track: trackID.optional() }).strict().parse(request.body);
  if (module === 'media' && track) throw new PublicError(400, '自媒体项目不使用课程轨道。');
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, owner, module, title, track) VALUES (?,?,?,?,?)').run(id, session.owner, module, title, track ?? null);
  return reply.code(201).send({ id, module, title, track: track ?? null, task_count: 0 });
});
app.get(`${prefix}/projects/:id`, async request => {
  const { id } = request.params as { id: string };
  const session = auth(request);
  const { module, title, track } = projectFor(id, session.owner);
  const rows = db.prepare('SELECT snapshot FROM tasks WHERE project=? AND owner=? ORDER BY rowid DESC').all(id, session.owner) as TaskRow[];
  return { id, module, title, track: track ?? null, task_count: rows.length, tasks: rows.map(snap) };
});
app.post(`${prefix}/assets`, async (request, reply) => {
  const session = auth(request);
  const { project_id } = z.object({ project_id: z.string().uuid() }).parse(request.query);
  if (projectFor(project_id, session.owner).module !== 'classroom') throw new PublicError(400, '请在课上项目上传材料。');
  const part = await request.file();
  const suppliedName = part ? path.basename(path.win32.basename(part.filename)).replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const extension = materialExtension(suppliedName);
  if (!part || !extension) {
    part?.file.resume();
    throw new PublicError(415, '请选择 PDF、Word（DOCX）、PPTX、TXT、Markdown 或 PNG / JPEG / WebP 图片。');
  }
  const filename = suppliedName.slice(0, 180);
  const id = randomUUID();
  const destination = path.join(data, 'assets', `${id}${extension}`);
  try {
    await pipeline(part.file, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (part.file.truncated) throw new PublicError(413, '材料须小于 32 MiB。');
    const header = Buffer.alloc(12);
    const file = await open(destination, 'r');
    let bytes: number;
    try { ({ bytesRead: bytes } = await file.read(header, 0, header.length, 0)); } finally { await file.close(); }
    if (!matchesMaterialHeader(extension, header.subarray(0, bytes))) throw new PublicError(415, '文件内容与所选格式不一致。');
    db.prepare('INSERT INTO assets (id,project,extension,filename) VALUES (?,?,?,?)').run(id, project_id, extension, filename);
    return reply.code(201).send({ asset_id: id });
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
});
app.post(`${prefix}/tasks`, async (request, reply) => {
  const session = auth(request);
  const input = taskInput.parse(request.body);
  const key = z.string().uuid().parse(request.headers['idempotency-key']);
  const project = projectFor(input.project_id, session.owner);
  if (project.module !== input.module) throw new PublicError(400, '项目与任务模块不匹配。');
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = db.prepare('SELECT id, digest FROM tasks WHERE owner=? AND idem=?').get(session.owner, key);
  if (existing) {
    if (existing.digest !== digest) throw new PublicError(409, '此提交标识已用于另一项请求。');
    return reply.code(202).send({ task_id: existing.id });
  }
  if (input.action === 'recover_script') {
    const prior = taskFor(input.input.prior_task_id, session);
    const snapshot = snap(prior);
    if (prior.project !== project.id || !['failed', 'interrupted'].includes(snapshot.status)) throw new PublicError(409, '此项目暂无可找回的稿件。');
  }
  let asset: Asset | undefined;
  if (input.module === 'classroom') {
    asset = db.prepare('SELECT id,extension,filename FROM assets WHERE id=? AND project=?').get(input.asset_ids[0], project.id) as Asset | undefined;
    if (!asset) throw new PublicError(404, '素材不可用。');
    if (input.input.pages && asset.extension !== '.pdf') throw new PublicError(400, '页码仅用于 PDF 材料。');
    if (project.track && project.track !== input.input.track) throw new PublicError(409, '请使用本项目的课程轨道。');
  }
  if (jobs.size >= 2) throw new PublicError(429, '当前任务正在处理，请稍后重试。');
  const snapshot: Snapshot = { task_id: randomUUID(), revision: 1, status: 'queued', title: project.title,
    summary: '任务已接收。', artifact_ids: [], next_action: null };
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(snapshot.task_id, session.owner, project.id, key, digest, JSON.stringify(snapshot));
  if (input.module === 'classroom' && !project.track) db.prepare('UPDATE projects SET track=? WHERE id=? AND owner=?').run(input.input.track, project.id, session.owner);
  const job = delay(60).then(() => runTask(snapshot, input, asset));
  jobs.add(job);
  void job.catch(() => console.error(JSON.stringify({ code: 'TASK_PERSIST_FAILED' }))).finally(() => jobs.delete(job));
  return reply.code(202).send({ task_id: snapshot.task_id });
});
app.get(`${prefix}/tasks/:id`, async request => snap(taskFor((request.params as { id: string }).id, auth(request))));
app.get(`${prefix}/tasks/:id/events`, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const session = auth(request);
  const current = taskFor(id, session);
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  const client = { session, response };
  const subscribers = streams.get(id) ?? new Set<Subscriber>();
  streams.set(id, subscribers);
  subscribers.add(client);
  response.write('retry: 750\n\n');
  sendSnapshot(client, snap(current));
  const heartbeat = setInterval(() => {
    if (sessions.get(session.token) !== session || session.expires <= Date.now()) response.end();
    else response.write(': keepalive\n\n');
  }, 8000);
  response.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(client);
    if (subscribers.size === 0) streams.delete(id);
  });
});

function artifactFor(id: string, session: Session) {
  const row = db.prepare('SELECT card FROM artifacts JOIN tasks ON artifacts.task=tasks.id WHERE artifacts.id=? AND tasks.owner=?').get(id, session.owner);
  if (!row) throw new PublicError(404, '成果不可用。');
  return JSON.parse(row.card as string);
}
app.get(`${prefix}/artifacts/:id`, async request => artifactFor((request.params as { id: string }).id, auth(request)));
app.get(`${prefix}/artifacts/:id/download`, async (request, reply) => {
  const { id } = request.params as { id: string };
  const card = artifactFor(id, auth(request));
  const { format } = z.object({ format: z.enum(['txt', 'html', 'pptx']) }).parse(request.query);
  if ((card.kind === 'script') !== (format === 'txt')) throw new PublicError(404, '文件不可用。');
  const file = card.kind === 'script' ? 'script.txt' : `lesson.${format}`;
  const types = { txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  return reply.header('Content-Disposition', `attachment; filename="${file}"`).type(types[format]).send(createReadStream(previewPath(id, file)));
});
app.get(`${prefix}/artifacts/:id/preview`, async (request, reply) => {
  const { id } = request.params as { id: string };
  if (artifactFor(id, auth(request)).kind !== 'lesson') throw new PublicError(404, '预览不可用。');
  return reply.header('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'")
    .type('text/html; charset=utf-8').send(createReadStream(previewPath(id, 'lesson.html')));
});

const mime: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
app.get('/', async (_request, reply) => reply.header('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'").type(mime['.html']).send(await readFile(path.join(web, 'index.html'))));
app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
app.get('/assets/:name', async (request, reply) => {
  const { name } = request.params as { name: string };
  if (!/^[a-zA-Z0-9_-]+\.(css|js)$/.test(name)) throw new PublicError(404, '文件不可用。');
  return reply.type(mime[path.extname(name)]).send(await readFile(path.join(web, 'assets', name)));
});
app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '页面或接口不可用。' }));

const certificate = await Promise.all(['localhost.key', 'localhost.crt'].map(name => readFile(path.join(data, name))));
await app.listen({ host: '127.0.0.1', port: 0 });
const apiAddress = app.server.address();
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Local API unavailable');
const qaMarker = path.join(data, 'qa-stream-cut');
const proxyStreams = new Map<ServerResponse, string>();
let cutTask = '';
const qaMonitor = qaEnabled ? setInterval(async () => {
  cutTask = (await readFile(qaMarker, 'utf8').catch(() => '')).trim();
  if (cutTask) for (const [response, task] of proxyStreams) if (task === cutTask) response.destroy();
}, 50) : undefined;
const bridge = createTlsServer({ key: certificate[0], cert: certificate[1] }, (request, response) => {
  if (request.headers.host !== `127.0.0.1:${originPort}`) { response.writeHead(421).end(); return; }
  const task = qaEnabled ? /^\/api\/v1\/tasks\/([a-f0-9-]+)\/events$/.exec(request.url ?? '')?.[1] : undefined;
  if (task) {
    // The QA gate changes only loopback proxy transport. It cannot change task state.
    if (cutTask === task) { response.destroy(); return; }
    proxyStreams.set(response, task);
    response.once('close', () => proxyStreams.delete(response));
  }
  const connection = forward({ hostname: '127.0.0.1', port: apiAddress.port, method: request.method, path: request.url, headers: request.headers }, upstream => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    response.flushHeaders();
    upstream.on('error', () => response.destroy());
    response.on('close', () => upstream.destroy());
    upstream.pipe(response);
  });
  response.on('close', () => connection.destroy());
  connection.on('error', () => { if (response.headersSent) response.destroy(); else response.writeHead(502).end(); });
  request.pipe(connection);
});
await new Promise<void>((resolve, reject) => bridge.once('error', reject).listen(originPort, '127.0.0.1', resolve));
console.log(`M0 listening on ${origin}`);
async function stop() {
  clearInterval(qaMonitor);
  bridge.close();
  for (const clients of streams.values()) for (const client of clients) client.response.end();
  await Promise.allSettled(jobs);
  await app.close();
  await media?.close();
  db.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
