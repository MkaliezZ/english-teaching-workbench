import { useState } from 'react';
import { AudioLines, BookOpen, ChevronDown, ChevronRight, FileText, FolderClosed, FolderOpen, Layers3, LogOut, Plus, X } from 'lucide-react';
import { taskStatuses, tracks } from './api';
import type { ModuleId, Project, Snapshot } from './api';

type Props = {
  module: ModuleId; entries: Project[]; current?: string; task?: string; expanded?: string; active?: Snapshot;
  history: Record<string, Project>; loading: boolean; busy: boolean; mobileOpen: boolean;
  onModule: (module: ModuleId) => void; onNew: () => void; onProject: (entry: Project) => void;
  onExpand: (entry: Project) => void; onTask: (entry: Project, task: Snapshot) => void;
  onClose: () => void; onLogout: () => void;
};

export function ProjectSidebar(props: Props) {
  const { module, current, task, expanded, history, entries } = props;
  const [folded, setFolded] = useState<Record<string, boolean>>({ other: true });
  const local = entries.filter(entry => entry.module === module);
  const groups = module === 'classroom' ? [
    ...Object.entries(tracks).map(([key, label]) => ({ key, label, projects: local.filter(entry => entry.track === key) })),
    { key: 'other', label: '未分轨项目', projects: local.filter(entry => !entry.track) },
  ] : [{ key: 'media', label: '创作', projects: local }];

  return <aside id="workbench-sidebar" className={`workbench-sidebar${props.mobileOpen ? ' mobile-open' : ''}`} aria-label="项目导航">
    <div className="wb-brand"><span className="wb-brand-mark"><Layers3 size={19} /></span><strong>英语教培工作台</strong>
      <button className="wb-icon close-sidebar" type="button" aria-label="关闭项目导航" onClick={props.onClose}><X /></button></div>
    <div className="wb-module-nav" aria-label="工作模块">
      <button type="button" aria-pressed={module === 'media'} onClick={() => props.onModule('media')} disabled={props.busy}><AudioLines />自媒体</button>
      <button type="button" aria-pressed={module === 'classroom'} onClick={() => props.onModule('classroom')} disabled={props.busy}><BookOpen />课上</button>
    </div>
    <div className="wb-project-header"><h2>{module === 'classroom' ? '课程项目' : '创作项目'}</h2>
      <button className="wb-icon" type="button" aria-label="新建项目" title="新建项目" onClick={props.onNew} disabled={props.busy}><Plus size={18} /></button>
    </div>
    <div className="wb-project-tree">
      {props.loading && local.length === 0 && <p className="wb-project-empty">正在读取项目…</p>}
      {!props.loading && local.length === 0 && <p className="wb-project-empty">新建一个项目即可开始。</p>}
      {groups.filter(group => group.projects.length > 0).map(group => {
        const open = !folded[group.key];
        return <section className="wb-project-group" key={group.key} aria-label={module === 'classroom' ? group.label : '创作项目列表'}>
          {module === 'classroom' && <button className="wb-group-button" type="button" onClick={() => setFolded(state => ({ ...state, [group.key]: open }))} aria-expanded={open} aria-controls={`group-${group.key}`}>
            {open ? <ChevronDown /> : <ChevronRight />}<span>{group.label}</span></button>}
          {open && <ul className="wb-folder-list" id={`group-${group.key}`}>{group.projects.map((entry, row) => {
            const selected = entry.id === current;
            const isOpen = entry.id === expanded;
            const saved = history[entry.id];
            const sameName = group.projects.filter(peer => peer.title === entry.title);
            const order = sameName.length > 1 ? group.projects.slice(row).filter(peer => peer.title === entry.title).length : 0;
            const count = saved?.tasks?.length ?? entry.task_count ?? 0;
            return <li key={entry.id} className="wb-folder">
              <div className={`wb-folder-row${selected ? ' is-current' : ''}`}>
                <button className="wb-project-button" type="button" onClick={() => props.onProject(entry)} title={entry.title} aria-current={selected ? 'page' : undefined} disabled={props.busy}>
                  {selected ? <FolderOpen /> : <FolderClosed />}<span>{entry.title}{order > 0 && <small>{`项目 ${order}`}</small>}</span>
                </button>
                {count > 0 && <button className="wb-icon wb-folder-expander" type="button" aria-label={`${isOpen ? '收起' : '展开'}${entry.title}的生成记录`} aria-expanded={isOpen} aria-controls={`history-${entry.id}`} onClick={() => props.onExpand(entry)}>
                  {isOpen ? <ChevronDown /> : <ChevronRight />}
                </button>}
              </div>
              {isOpen && count > 0 && <ul id={`history-${entry.id}`} className="wb-generation-list" aria-label={`${entry.title}的生成记录`}>
                {saved?.tasks ? saved.tasks.map((item, index) => <li key={item.task_id}>
                  <button type="button" className="wb-record" aria-current={item.task_id === task ? 'page' : undefined} onClick={() => props.onTask(entry, item)} disabled={props.busy}>
                    <FileText /><span>{index === 0 ? '最新生成' : `第 ${saved.tasks!.length - index} 次生成`}</span>
                    <small>{taskStatuses[item.task_id === props.active?.task_id ? props.active.status : item.status] ?? '查看记录'}</small>
                  </button></li>) : <li className="wb-project-empty">正在读取记录…</li>}
              </ul>}
            </li>;
          })}</ul>}
        </section>;
      })}
    </div>
    <div className="wb-sidebar-footer"><span>教师工作台</span><button className="wb-icon" type="button" title="退出登录" aria-label="退出登录" onClick={props.onLogout}><LogOut size={17} /></button></div>
  </aside>;
}
