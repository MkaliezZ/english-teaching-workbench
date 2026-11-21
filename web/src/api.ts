export type ModuleId = 'media' | 'classroom';
export type Track = 'k12' | 'toefl' | 'ielts';
export const tracks: Record<Track, string> = { k12: 'K12 英语', toefl: '托福', ielts: '雅思' };
export const taskStatuses: Record<string, string> = { queued: '已排队', running: '进行中', succeeded: '已完成', failed: '未完成', interrupted: '已中断' };
export type Project = { id: string; module: ModuleId; title: string; track?: Track | null; task_count?: number; tasks?: Snapshot[] };
export type Snapshot = { task_id: string; revision: number; status: string; title: string; summary: string; artifact_ids: string[]; next_action: string | null };
export type Session = { account: string; csrf_token: string };
type Segment = { start: number; end: number; spoken: string; visual: string; subtitle: string };
type ArtifactBase = { artifact_id: string; title: string; version: number; review_status: 'needs_review' };
export type Artifact = ArtifactBase & ({ kind: 'script'; segments: Segment[] } | {
  kind: 'lesson'; track: string; objective: string; source: string; pages: string; activities: number; slides: number;
});
export const base = '/api/v1';
export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function request<T>(route: string, options?: { payload: object | FormData; session?: Session; key?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  let body: FormData | string | undefined;
  if (options) {
    if (options.session) headers['X-CSRF-Token'] = options.session.csrf_token;
    if (options.key) headers['Idempotency-Key'] = options.key;
    if (options.payload instanceof FormData) body = options.payload;
    else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.payload); }
  }
  const response = await fetch(base + route, { method: options ? 'POST' : 'GET', headers, body, cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new RequestError(response.status, data.error ?? '服务暂时不可用。');
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function subscribe(task: string, accept: (snapshot: Snapshot) => void, connection: (caughtUp: boolean) => void, expired: () => void) {
  let closed = false;
  let timer: number | undefined;
  let failures = 0;
  let generation = 0;
  const stream = new EventSource(`${base}/tasks/${task}/events`);
  const sync = async (epoch: number) => {
    try {
      const snapshot = await request<Snapshot>(`/tasks/${task}`);
      if (!closed && epoch === generation) accept(snapshot);
    } catch (error) {
      if (!closed && error instanceof RequestError && [401, 404].includes(error.status)) expired();
    }
  };
  const poll = async (epoch: number) => {
    await sync(epoch);
    if (!closed && epoch === generation) timer = window.setTimeout(() => void poll(epoch), Math.min(8000, 500 * 2 ** failures++));
  };
  stream.addEventListener('task.snapshot', event => {
    try {
      const snapshot: Snapshot = JSON.parse(event.data);
      if (closed || snapshot.task_id !== task || String(snapshot.revision) !== event.lastEventId) return;
      generation++;
      window.clearTimeout(timer);
      timer = undefined;
      failures = 0;
      accept(snapshot);
      connection(true);
    } catch { /* Ignore malformed event and keep last valid snapshot. */ }
  });
  stream.onerror = () => {
    if (closed) return;
    connection(false);
    if (timer === undefined) {
      timer = window.setTimeout(() => void poll(generation), 200);
    }
  };
  void sync(generation);
  return () => {
    closed = true;
    stream.close();
    window.clearTimeout(timer);
  };
}
