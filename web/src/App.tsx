import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, AudioLines, BookOpen, Check, Download, FileText, Layers3, LoaderCircle, Moon, PanelLeft, Paperclip, Plus, Sun, X } from 'lucide-react';
import { materialExtension, materialExtensions, maxMaterialBytes } from '../../shared/materials';
import { base, request, RequestError, subscribe, taskStatuses, tracks } from './api';
import type { Artifact, ModuleId, Project, Session, Snapshot, Track } from './api';
import { Modal } from './Modal';
import { ProjectSidebar } from './ProjectSidebar';
import './m0.css';

const modules = { media: '自媒体', classroom: '课上' };
type Theme = 'dark' | 'light';
const themeKey = 'english-workbench.theme';

function readTheme(): Theme {
  try { return localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

function readRoute(): { module: ModuleId; project?: string; task?: string } {
  const [module, project, task] = location.hash.slice(1).split('/');
  return { module: module === 'classroom' ? 'classroom' : 'media', project, task };
}
function message(error: unknown) { return error instanceof RequestError ? error.message : '连接暂时不可用，请重试。'; }

export function App() {
  const [theme, setTheme] = useState(readTheme);
  const [session, setSession] = useState<Session | null | undefined>();
  const [route, setRoute] = useState(readRoute);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [history, setHistory] = useState<Record<string, Project>>({});
  const [expanded, setExpanded] = useState<string>();
  const [mobileNav, setMobileNav] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [artifact, setArtifact] = useState<Artifact>();
  const [connected, setConnected] = useState<boolean>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [track, setTrack] = useState<Track>('k12');
  const [pages, setPages] = useState('');
  const [goal, setGoal] = useState('');
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = useRef<{ signature: string; key: string; project?: Project; asset?: string } | undefined>(undefined);
  const recoveryKey = useRef<{ task: string; key: string } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const closePreview = useCallback(() => setPreview(undefined), []);
  const { module, project, task } = route;
  const projectEntry = project ? history[project] ?? projects.find(item => item.id === project) : undefined;
  const selectedTrack = projectEntry?.track ?? track;
  const taskInProject = Boolean(task && projectEntry?.module === module && projectEntry?.tasks?.some(item => item.task_id === task));
  const isPDF = file ? materialExtension(file.name) === '.pdf' : false;
  const invalidPages = isPDF && pages.trim() !== '' && !/^[1-9]\d{0,2}-[1-9]\d{0,2}$/.test(pages.trim());
  const composerOpen = !task;
  const active = snapshot?.task_id === task ? snapshot : undefined;
  const artifactId = active?.artifact_ids[0];
  const currentArtifact = artifact?.artifact_id === artifactId ? artifact : undefined;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    const pageColor = getComputedStyle(root).getPropertyValue('--wb-bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', pageColor);
  }, [theme]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(themeKey, next); }
    catch { /* The theme still works for the current page if storage is unavailable. */ }
  }

  useEffect(() => {
    request<Session>('/context').then(setSession).catch(() => setSession(null));
    const read = () => {
      const next = readRoute();
      setRoute(next); setExpanded(next.project); setError(''); setPreview(undefined); setPanelOpen(false); setMobileNav(false); setCopied(false);
    };
    addEventListener('hashchange', read);
    return () => removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    if (!session) return;
    let ignore = false;
    setLoadingProjects(true);
    request<Project[]>(`/projects?module=${module}`).then(value => { if (!ignore) setProjects(value); })
      .catch(error => { if (!ignore) setError(message(error)); }).finally(() => { if (!ignore) setLoadingProjects(false); });
    return () => { ignore = true; };
  }, [session, module, project, task]);
  useEffect(() => {
    if (!session || !project) return;
    let ignore = false;
    request<Project>(`/projects/${project}`).then(saved => {
      if (!ignore) {
        if (saved.module !== module || (task && !saved.tasks?.some(item => item.task_id === task))) {
          setError('此生成记录不属于当前项目。');
          return;
        }
        setHistory(items => ({ ...items, [saved.id]: saved }));
        setExpanded(saved.id);
      }
    }).catch(error => { if (!ignore) setError(message(error)); });
    return () => { ignore = true; };
  }, [session, module, project, task]);
  useEffect(() => {
    setSnapshot(undefined);
    setConnected(undefined);
    if (!task || !session || !taskInProject) return;
    return subscribe(task, next => {
      if (next.task_id !== task) return;
      setSnapshot(current => !current || current.task_id !== task || next.revision > current.revision ? next : current);
    }, setConnected, () => setError('无法继续读取任务，请检查登录状态。'));
  }, [task, session, taskInProject]);
  useEffect(() => {
    if (!artifactId || !session) return;
    let ignore = false;
    request<Artifact>(`/artifacts/${artifactId}`).then(value => { if (!ignore) setArtifact(value); })
      .catch(error => { if (!ignore) setError(message(error)); });
    return () => { ignore = true; };
  }, [artifactId, session]);

  function navigate(to: ModuleId, selected?: Project, taskId?: string) {
    setMobileNav(false);
    location.hash = [to, selected?.id, taskId].filter(Boolean).join('/');
  }
  async function projectHistory(selected: Project) {
    const saved = await request<Project>(`/projects/${selected.id}`);
    setHistory(items => ({ ...items, [saved.id]: saved }));
    return saved;
  }
  async function openProject(selected: Project) {
    try {
      const saved = await projectHistory(selected);
      setExpanded(saved.id);
      navigate(saved.module, saved, saved.tasks?.[0]?.task_id);
    } catch (error) { setError(message(error)); }
  }
  function toggleHistory(selected: Project) {
    if (selected.id === expanded) { setExpanded(undefined); return; }
    setExpanded(selected.id);
    void projectHistory(selected).catch(error => { setExpanded(undefined); setError(message(error)); });
  }
  function startNew(to: ModuleId = module, target?: Project) {
    draft.current = undefined;
    setError(''); setFile(undefined); setPages(''); setGoal(''); setPrompt('');
    navigate(to, target);
  }
  function selectMaterial(value?: File) {
    if (!value) return;
    setError('');
    if (!materialExtension(value.name)) { setError('请选择 PDF、Word、PPTX、文本或图片。'); return; }
    if (!value.size || value.size >= maxMaterialBytes) { setError('请选择小于 32 MiB 的非空材料。'); return; }
    draft.current = undefined;
    setFile(value); setPages('');
  }
  async function submit() {
    if (!session || busy || (project && !projectEntry) || (module === 'media' ? prompt.trim().length < 12 : !file)) return;
    if (invalidPages) { setError('请填写起始页-结束页，例如 28-35，或留空自动选页。'); return; }
    setBusy(true);
    setError('');
    const signature = JSON.stringify([module, project, prompt, selectedTrack, pages, goal, file?.name, file?.lastModified, file?.size]);
    const submission = draft.current?.signature === signature ? draft.current : { signature, key: crypto.randomUUID(), project: projectEntry };
    draft.current = submission;
    try {
      const title = module === 'media' ? prompt.trim().split('\n')[0].slice(0, 38) : file?.name.replace(/\.[a-z0-9]+$/i, '').trim().slice(0, 65);
      submission.project ??= await request<Project>('/projects', { session, payload: { module, title: title || (module === 'media' ? '自媒体口播稿' : `${tracks[selectedTrack]}课堂包`), ...(module === 'classroom' ? { track: selectedTrack } : {}) } });
      if (module === 'classroom' && file && !submission.asset) {
        const payload = new FormData();
        payload.append('file', file);
        submission.asset = (await request<{ asset_id: string }>(`/assets?project_id=${submission.project.id}`, { session, payload })).asset_id;
      }
      const { task_id } = await request<{ task_id: string }>('/tasks', { session, key: submission.key, payload: {
        module, project_id: submission.project.id, action: module === 'media' ? 'draft_script' : 'generate_lesson',
        input: module === 'media' ? { prompt: prompt.trim() } : { track: selectedTrack, ...(isPDF && pages.trim() ? { pages: pages.trim() } : {}), ...(goal.trim() ? { goal: goal.trim() } : {}) }, asset_ids: submission.asset ? [submission.asset] : [],
      } });
      draft.current = undefined;
      if (module === 'classroom') setFile(undefined);
      navigate(module, submission.project, task_id);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function login(form: FormData) {
    setError('');
    try { setSession(await request<Session>('/session', { payload: { account: form.get('account'), password: form.get('password') } })); }
    catch (error) { setError(message(error)); }
  }
  async function recoverScript() {
    if (!session || !task || !project || busy) return;
    recoveryKey.current = recoveryKey.current?.task === task ? recoveryKey.current : { task, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const receipt = await request<{ task_id: string }>('/tasks', { session, key: recoveryKey.current.key, payload: {
        module: 'media', project_id: project, action: 'recover_script', input: { prior_task_id: task }, asset_ids: [],
      } });
      location.hash = `media/${project}/${receipt.task_id}`;
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (!session) return;
    try {
      await request('/session/end', { session, payload: {} });
      setSession(null);
      setProjects([]);
      setArtifact(undefined);
      navigate('media');
    } catch (error) { setError(message(error)); }
  }

  if (session === undefined) return <main className="loading-app"><LoaderCircle className="spin" aria-label="正在连接" /></main>;
  const nextThemeLabel = theme === 'dark' ? '浅色' : '深色';
  const themeAction = `切换到${nextThemeLabel}模式`;
  const themeToggle = <button className="wb-icon wb-theme-toggle" type="button" aria-label={themeAction} title={themeAction} onClick={toggleTheme}>
    {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}<span>{nextThemeLabel}</span>
  </button>;
  if (!session) return <main className="m0-login">{themeToggle}<form className="composer" onSubmit={event => { event.preventDefault(); void login(new FormData(event.currentTarget)); }}>
    <span className="brand-mark"><AudioLines /></span><h1>英语教培工作台</h1><label>本机账号<select name="account"><option value="teacher">教师</option><option value="reviewer">隔离测试账号</option></select></label>
    <label>验证口令<input name="password" type="password" required autoComplete="current-password" /></label><button className="primary">登录</button>{error && <p role="alert">{error}</p>}
  </form></main>;

  const submitLabel = module === 'media' ? '生成口播稿' : '生成课堂包';
  const initialHeading = module === 'media' ? '写一份口播稿' : '准备一节英语课';
  const composer = <form className={`wb-compose${dragging ? ' is-dragging' : ''}`} onSubmit={event => { event.preventDefault(); void submit(); }}
    onDragOver={event => { if (module === 'classroom' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
    onDrop={event => {
      if (module !== 'classroom' || !event.dataTransfer.files.length) return;
      event.preventDefault(); setDragging(false);
      if (event.dataTransfer.files.length > 1) { setError('每次生成请选择一个文件。'); return; }
      if (!busy) selectMaterial(event.dataTransfer.files[0]);
    }}>
    {module === 'classroom' && file && <div className="wb-attachment"><span className="wb-attachment-icon"><FileText size={18} /></span><div><strong title={file.name}>{file.name}</strong><small>{materialExtension(file.name)?.slice(1).toUpperCase()} · {file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}</small></div>
      <button type="button" className="wb-icon" aria-label="移除材料" onClick={() => { draft.current = undefined; setFile(undefined); setPages(''); }} disabled={busy}><X size={16} /></button></div>}
    {module === 'media' ? <textarea aria-label="口播需求" placeholder="写下主题、受众和希望读者带走的观点" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={3000} rows={3} disabled={busy} />
      : <textarea aria-label="备课重点" placeholder="这节课想重点讲什么？（选填）" value={goal} onChange={event => setGoal(event.target.value)} maxLength={300} rows={3} disabled={busy} />}
    <div className="wb-compose-bar">
      {module === 'classroom' && <><input ref={fileInput} aria-label="本地材料" className="visually-hidden" type="file" accept={materialExtensions.join(',')} onChange={event => { selectMaterial(event.target.files?.[0]); event.target.value = ''; }} disabled={busy} />
        <button className="wb-pill wb-material" type="button" onClick={() => fileInput.current?.click()} disabled={busy}><Paperclip size={16} />选择本地材料</button>
        <select className="wb-pill" aria-label="课程轨道" value={selectedTrack} disabled={busy || Boolean(projectEntry?.track)} onChange={event => setTrack(event.target.value as Track)}>{Object.entries(tracks).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        {isPDF && <input className="wb-pill wb-page-range" aria-label="PDF 页码" title="留空自动选页，或输入范围，如 28-35" placeholder="页码范围（选填）" value={pages} onChange={event => setPages(event.target.value)} maxLength={7} />}
      </>}
      <span className="spacer" /><button className="wb-send" type="submit" disabled={busy || (project && !projectEntry) || (module === 'media' ? prompt.trim().length < 12 : !file)}>
        {busy ? '正在提交' : submitLabel}{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={16} />}</button>
    </div>
  </form>;

  return <div className={`wb-shell${panelOpen ? ' wb-with-detail' : ''}`}>
    {mobileNav && <button className="wb-mobile-scrim" type="button" aria-label="关闭侧栏" onClick={() => setMobileNav(false)} />}
    <ProjectSidebar module={module} entries={projects} current={project} task={task} expanded={expanded} active={active} history={history} loading={loadingProjects} busy={busy} mobileOpen={mobileNav}
      onModule={target => { if (module === target) navigate(target); else startNew(target); }} onNew={() => startNew()}
      onProject={entry => void openProject(entry)} onExpand={toggleHistory} onTask={(entry, item) => navigate(entry.module, entry, item.task_id)}
      onClose={() => setMobileNav(false)} onLogout={() => void logout()} />
    <main className="wb-workspace">
      <header className="wb-topbar"><button type="button" className="wb-icon open-sidebar" aria-label="打开项目导航" aria-expanded={mobileNav} aria-controls="workbench-sidebar" onClick={() => setMobileNav(true)}><PanelLeft size={19} /></button>
        <div className="wb-breadcrumb"><span>{modules[module]}</span>{project && <><span className="wb-divider">/</span><strong>{projectEntry?.title ?? active?.title ?? '项目'}</strong></>}</div>
        <div className="wb-topbar-actions">
          {task && projectEntry && <button type="button" className="wb-pill" onClick={() => startNew(module, projectEntry)} disabled={busy}><Plus size={15} />本项目新建</button>}
          {themeToggle}
        </div>
      </header>
      {composerOpen ? <div className="wb-entry-scroll"><section className="wb-entry">
        <span className="wb-work-mark">{module === 'media' ? <AudioLines size={27} /> : <Layers3 size={27} />}</span>
        <h1>{project ? `在${projectEntry?.title ? `「${projectEntry.title}」` : '项目'}中继续` : initialHeading}</h1>
        {composer}<p className="wb-compose-note">{module === 'media' ? '提交的口播需求将由配置的模型处理。' : '支持 PDF、Word（DOCX）、PPTX、TXT、Markdown 和 PNG / JPEG / WebP。'}</p>
        {error && <p className="wb-error" role="alert">{error}</p>}
      </section></div> : <div className="wb-transcript"><section className="wb-turn" aria-label="任务状态">
        <div className="wb-turn-identity"><span className="wb-brand-mark"><Layers3 size={17} /></span><strong>{modules[module]}工作台</strong></div>
        <div className="wb-status" role="status" data-revision={active?.revision} data-task-id={active?.task_id}>
          <div>{active?.status === 'succeeded' ? <Check size={17} /> : ['running', 'queued'].includes(active?.status ?? '') ? <LoaderCircle size={17} className="spin" /> : <FileText size={17} />}<strong>{active ? taskStatuses[active.status] ?? '等待任务' : '正在读取任务'}</strong></div><p>{active?.summary}</p>{connected === false && <p>连接已断开，正在恢复。</p>}
        </div>
        {module === 'media' && ['recover_script', 'retry'].includes(active?.next_action ?? '') && <button className="wb-pill wb-recover" onClick={() => void recoverScript()} disabled={busy}>尝试取回已保存稿件</button>}
        {module === 'classroom' && active?.next_action === 'retry' && projectEntry && <button className="wb-pill wb-recover" onClick={() => startNew(module, projectEntry)}>重新选择材料</button>}
        {currentArtifact && <button className="wb-result-card" onClick={() => setPanelOpen(true)}><span className="wb-attachment-icon">{currentArtifact.kind === 'script' ? <FileText /> : <BookOpen />}</span><span className="wb-card-text"><strong>{currentArtifact.title}</strong><small>{currentArtifact.kind === 'script' ? '口播文稿' : '互动 HTML · 可编辑 PPTX'}</small></span><span className="wb-card-open">查看成果 <ArrowRight size={16} /></span></button>}
        {error && <p className="wb-error" role="alert">{error}</p>}
      </section></div>}
    </main>
    {panelOpen && currentArtifact && <aside className="wb-details" aria-label="成果面板"><header><strong>成果</strong><button className="wb-icon" aria-label="关闭成果面板" onClick={() => setPanelOpen(false)}><X size={17} /></button></header>
      <div className="wb-details-content"><h2>{currentArtifact.title}</h2><div className="wb-review-state">待审阅</div>
      {currentArtifact.kind === 'script' ? <><div className="wb-detail-actions"><button className="wb-pill" onClick={async () => { try { await navigator.clipboard.writeText(currentArtifact.segments.map(item => item.spoken).join('\n\n')); setCopied(true); } catch { setError('暂时无法复制，请使用下载。'); } }}>{copied ? '已复制' : '复制口播词'}</button>
        <a className="wb-pill" href={`${base}/artifacts/${artifactId}/download?format=txt`}><Download size={15} />下载文稿</a></div>
        {currentArtifact.segments.map((item, index) => <section className="wb-script-block" key={index}><div>口播片段 {index + 1}<time>{item.start}–{item.end} 秒</time></div><p>{item.spoken}</p><small>画面　{item.visual}</small><br /><small>字幕　{item.subtitle}</small></section>)}</>
        : <><p>{currentArtifact.objective}</p><p className="wb-source">{currentArtifact.source}</p><p>{currentArtifact.activities} 项互动活动 · {currentArtifact.slides} 页幻灯片</p><div className="wb-detail-actions"><button className="wb-send" onClick={() => setPreview(`${base}/artifacts/${artifactId}/preview`)}>预览互动 HTML</button>
          <a className="wb-pill" href={`${base}/artifacts/${artifactId}/download?format=pptx`}><Download size={15} />下载 PPTX</a><a className="wb-pill" href={`${base}/artifacts/${artifactId}/download?format=html`}><Download size={15} />下载 HTML</a></div></>}
      </div></aside>}
    {preview && <Modal title="课堂包教师预览" onClose={closePreview} wide><iframe className="m0-preview" title="互动课堂" src={preview} sandbox="allow-scripts allow-forms" /></Modal>}
  </div>;
}
