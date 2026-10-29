import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, ClipboardList, Code2, Compass, FolderKanban, Gamepad2, GitBranch, Palette, Play, Plus, ShieldCheck, Sparkles, Users, Wrench } from 'lucide-react';
import { ErrorMessage, request } from './phase-ui';
import './studio-village.css';

export const STUDIO_AGENTS = [
  { id: 'planner', name: 'Lập kế hoạch', title: 'Lập kế hoạch', icon: Compass, color: '#a98c54', description: 'Biến yêu cầu thành kế hoạch, nhiệm vụ và điều kiện nghiệm thu. Kế hoạch cần được duyệt trước khi áp dụng.' },
  { id: 'game_designer', name: 'Thiết kế game', title: 'Cách chơi & cơ chế', icon: Gamepad2, color: '#9e695e', description: 'Thiết kế vòng lặp gameplay, nhân vật, nhiệm vụ, cơ chế và cân bằng cho game của bạn.' },
  { id: 'ui_designer', name: 'Thiết kế giao diện', title: 'Giao diện & trải nghiệm', icon: Palette, color: '#7c849b', description: 'Phác thảo màn hình, luồng người chơi, bố cục và đặc tả tài nguyên đồ họa.' },
  { id: 'developer', name: 'Lập trình', title: 'Phát triển mã nguồn', icon: Code2, color: '#658c82', description: 'Đề xuất mã nguồn theo yêu cầu. Thay đổi được lưu để chủ dự án duyệt trước khi chuyển sang mã nguồn hoặc build.' },
  { id: 'tester', name: 'Kiểm thử', title: 'Kiểm thử game', icon: Check, color: '#79945c', description: 'Thiết kế kiểm thử và phân tích lỗi. Chỉ kết quả từ runner thật mới xác nhận mã đã chạy qua kiểm thử.' },
  { id: 'reviewer', name: 'Đánh giá', title: 'Đánh giá & nghiệm thu', icon: ShieldCheck, color: '#9a7b99', description: 'Đối chiếu sản phẩm với yêu cầu, rà soát thay đổi và ghi rõ phần còn thiếu bằng chứng.' },
  { id: 'build_engineer', name: 'Dựng bản game', title: 'Chuẩn bị bản dựng', icon: Wrench, color: '#a37a4f', description: 'Chuẩn bị bundle và đề xuất build. Chủ dự án duyệt trước khi runner tạo bản dựng, log và artifact.' },
  { id: 'coordinator', name: 'Điều phối', title: 'Điều phối dự án', icon: Users, color: '#6f859e', description: 'Theo dõi nhiệm vụ, xác định việc bị chặn và đề xuất phân công cho nhóm.' },
] as const;

export type StudioSelection = { projectId: string; agent: string; revision: number };
export type ProjectDestination = 'tasks' | 'planning' | 'source' | 'build';
type Project = { id: string; name: string; role?: string; locked?: boolean; progress?: number; taskCount?: number };
const sourceRoles = ['owner', 'manager', 'developer', 'tester', 'reviewer'];
const jobLabels: Record<string, string> = { pending: 'Đang chờ', planning: 'Đang phân tích', running: 'Đang thực thi', waiting_approval: 'Chờ duyệt', reviewing: 'Đang xem xét', completed: 'Hoàn thành', failed: 'Thất bại', paused: 'Tạm dừng', cancelled: 'Đã hủy', interrupted: 'Gián đoạn' };

export function StudioVillage({ user, projects, selection, connected, onSelect, onNewRequest, onOpenProject }: {
  user: { id: string } | null; projects: Project[]; selection: StudioSelection; connected: boolean;
  onSelect: (projectId: string, agent: string) => void; onNewRequest: () => void;
  onOpenProject: (projectId: string, destination: ProjectDestination) => void;
}) {
  const [detail, setDetail] = useState<any>(null), [jobs, setJobs] = useState<any[]>([]), [error, setError] = useState('');
  const project = projects.find(item => item.id === selection.projectId);
  const visible = detail?.project?.id === project?.id ? detail : null;
  const role = visible?.project.role || project?.role;
  const sourceAllowed = sourceRoles.includes(role || '');
  const agent = STUDIO_AGENTS.find(item => item.id === selection.agent) || STUDIO_AGENTS[0];
  const currentJobs = sourceAllowed ? jobs.filter(job => job.projectId === project?.id) : [];
  useEffect(() => {
    let active = true;
    setDetail(null); setJobs([]); setError('');
    if (!user || !project) return;
    const load = async () => {
      try {
        const next = await request('/projects/' + project.id);
        const list = sourceRoles.includes(next.project.role) ? await request('/ai/projects/' + project.id + '/jobs') : { jobs: [] };
        if (active) { setDetail(next); setJobs(list.jobs); setError(''); }
      } catch (e) { if (active) { setDetail(null); setJobs([]); setError((e as Error).message); } }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [user?.id, project?.id, project?.role]);
  const ready = !!visible;
  const completed = visible?.tasks.filter((task: any) => task.status === 'done').length || 0;
  const total = visible?.tasks.length || 0;
  return <section className="studio-village" aria-label="Làng Studio thiết kế game">
    <div className="studio-village-heading"><div><span className="eyebrow">PIXEL AI WORLD · XƯỞNG THIẾT KẾ GAME</span><h2>Một ý tưởng. Cả xưởng cùng xây.</h2><p>Chọn dự án và bàn làm việc để chuẩn bị yêu cầu cho đúng vai trò.</p></div><button className="button button-primary" onClick={onNewRequest}><Plus size={16}/> Tạo yêu cầu game</button></div>
    <div className="studio-village-layout">
      <aside className="studio-projects" aria-label="Dự án trong xưởng"><div className="studio-rail-heading"><FolderKanban size={17}/><h3>Dự án trong xưởng</h3></div>
        <label>Dự án đang thiết kế<select aria-label="Dự án đang thiết kế" value={project?.id || ''} disabled={!user} onChange={e => onSelect(e.target.value, selection.agent)}><option value="">Chọn dự án của bạn</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {!user ? <p className="hint">Đăng nhập để lưu yêu cầu, dự án và lịch sử làm việc.</p> : !projects.length ? <p className="hint">Tạo yêu cầu game đầu tiên. Xưởng sẽ lưu yêu cầu và tạo dự án riêng tư của bạn.</p> : <p className="hint">Mỗi dự án giữ riêng yêu cầu, quyền thành viên, nhiệm vụ và kết quả AI.</p>}
        <div className="studio-flow"><span className="eyebrow">HÀNH TRÌNH CỦA GAME</span>{[
          { name: 'Yêu cầu & kế hoạch', target: 'planning' as const, icon: ClipboardList },
          { name: 'Nhiệm vụ & cộng tác', target: 'tasks' as const, icon: Users },
          { name: 'Mã nguồn · GitHub', target: 'source' as const, icon: GitBranch },
          { name: 'Kiểm thử & bản build', target: 'build' as const, icon: Play },
        ].map(({name, target, icon: Icon}, index) => <button key={target} disabled={!ready || (['source', 'build'].includes(target) && !sourceAllowed)} onClick={() => onOpenProject(project!.id, target)}><span>{index + 1}</span><Icon size={15}/>{name}<ArrowRight size={13}/></button>)}</div>
      </aside>
      <div className="studio-room" aria-label="Tám bàn làm việc AI"><div className="studio-room-top"><div className="studio-window" aria-hidden="true"><span/><i/><i/></div><div><span className="eyebrow">BẢNG PHÂN CÔNG</span><strong>{project?.name || 'Chào mừng đến xưởng game'}</strong><small>8 vai trò · Bạn định hướng và phê duyệt</small></div><div className="studio-room-plant" aria-hidden="true">✦</div></div>
        <div className="studio-desks">{STUDIO_AGENTS.map(({id, name, title, icon: Icon, color}) => {
          const job = currentJobs.find(item => item.agent === id);
          const label = job ? jobLabels[job.status] || job.status : 'Chưa có tác vụ';
          return <button key={id} className={'studio-desk ' + (selection.agent === id ? 'is-selected' : '')} aria-pressed={selection.agent === id} aria-label={'Bàn ' + name + ' · ' + title} style={{'--agent-color': color} as React.CSSProperties} onClick={() => onSelect(project?.id || '', id)}>
            <span className="studio-desk-art" aria-hidden="true"><span className="studio-monitor"><Icon size={23}/></span><span className="studio-table"/><span className="studio-chair"/><span className="studio-agent-sprite"><i/><b/><em/></span></span>
            <strong>{name}</strong><span>{title}</span><small className={job && ['running', 'planning', 'reviewing'].includes(job.status) ? 'is-working' : ''}>{label}</small>
          </button>;
        })}</div><div className="studio-room-note"><Sparkles size={14}/><span>Chọn bàn để soạn yêu cầu. AI chỉ chạy khi bạn gửi tác vụ.</span></div>
      </div>
      <aside className="studio-project-status" aria-label="Tiến độ dự án trong xưởng"><span className="eyebrow">DỰ ÁN ĐANG LÀM</span><h3>{project?.name || 'Chưa chọn dự án'}</h3><ErrorMessage error={error}/>
        {ready ? <><div className="studio-progress-number">{visible.project.progress || 0}<span>%</span></div><div className="phase-progress" role="progressbar" aria-label="Tiến độ dự án" aria-valuenow={visible.project.progress || 0} aria-valuemin={0} aria-valuemax={100}><i style={{width: (visible.project.progress || 0) + '%'}}/></div><p className="hint">{completed}/{total} nhiệm vụ hoàn thành · {visible.members.length} thành viên</p><dl><div><dt>Đang làm</dt><dd>{visible.tasks.filter((task: any) => task.status === 'in_progress').length}</dd></div><div><dt>Chờ xem xét</dt><dd>{visible.tasks.filter((task: any) => task.status === 'review').length}</dd></div>{sourceAllowed && <div><dt>AI chờ duyệt</dt><dd>{currentJobs.filter(job => job.status === 'waiting_approval').length}</dd></div>}</dl>{!sourceAllowed && <p className="hint">Vai trò của bạn được xem tiến độ; mã nguồn và tác vụ AI cần quyền riêng.</p>}</> : <p className="hint">Tiến độ xuất hiện khi bạn chọn một dự án được cấp quyền. Yêu cầu mới luôn được lưu trước khi giao việc cho AI.</p>}
        <div className="studio-service-state"><span className={'status-dot ' + (connected ? '' : 'is-offline')}/><strong>{connected ? 'Đã cấu hình nhà cung cấp AI' : 'Chưa kết nối nhà cung cấp AI'}</strong><p>{connected ? 'Chọn model, đặt ngân sách và gửi tác vụ để bắt đầu.' : 'Bạn vẫn có thể lưu ý tưởng và quản lý dự án. Cấu hình nhà cung cấp trước khi gửi tác vụ AI.'}</p></div>
      </aside>
    </div>
    <div className="studio-selected-agent" aria-live="polite"><span className="studio-selected-icon"><agent.icon size={22}/></span><div><strong>{agent.name} · {agent.title}</strong><p>{agent.description}</p></div><button className="button button-outline" onClick={() => { document.getElementById('ai-workspace')?.scrollIntoView({behavior: 'instant', block: 'start'}); document.getElementById('ai-job-prompt')?.focus({preventScroll: true}); }}>Soạn yêu cầu <ArrowRight size={15}/></button></div>
  </section>;
}
