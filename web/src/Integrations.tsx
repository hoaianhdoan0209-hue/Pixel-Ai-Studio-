import React, { useEffect, useRef, useState } from 'react';
import { ActionForm, ErrorMessage, Notice, readableDate, request } from './phase-ui';
import { STARTER_NAME, STARTER_DESCRIPTION, STARTER_INSTRUCTIONS, STARTER_FILES } from './game-starter';

type ProjectAccess = { id: string; role?: string; locked?: boolean; visibility?: string };
type Connection = { id: string; userId: string; installationId: string; accountLogin: string; createdAt: string };
type Build = {
  id: string; authorId?: string; version: string; target: string; status: string; logs: string; exitCode: number | null;
  createdAt: string; startedAt?: string; finishedAt?: string;
  artifact?: { sha256: string; size: number; downloadUrl: string } | null;
};
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const buildLabels: Record<string, string> = { queued: 'Đang chờ', preparing: 'Chuẩn bị runner', building: 'Đang build', testing: 'Đang kiểm thử', succeeded: 'Thành công', failed: 'Thất bại', cancelled: 'Đã hủy' };
const canReadSource = (role?: string) => ['owner', 'manager', 'developer', 'tester', 'reviewer'].includes(role || '');
const canWrite = (project: ProjectAccess) => !project.locked || project.role === 'owner';

export function GitHubConnections({ user }: { user: any }) {
  const [connections, setConnections] = useState<Connection[]>([]), [users, setUsers] = useState<any[]>([]), [status, setStatus] = useState<any>(null), [error, setError] = useState('');
  const administrator = user?.roles?.includes('admin');
  async function load() {
    if (!user) return;
    try {
      const [list, configuration] = await Promise.all([request('/github/connections'), request('/integrations')]);
      setConnections(list.connections); setStatus(configuration.github); setError('');
      if (administrator) setUsers((await request('/admin')).users);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { setConnections([]); setUsers([]); void load(); }, [user?.id, administrator]);
  if (!user) return null;
  return <section className="panel phase-stack" aria-label="Kết nối GitHub App"><h2>GitHub App & quyền truy cập</h2><Notice>{status?.message || 'Đang đọc cấu hình GitHub App…'}</Notice><ErrorMessage error={error}/>
    <p className="hint">Khóa GitHub App và khóa mã hóa được cấu hình an toàn ở máy chủ. Không nhập private key hoặc token vào biểu mẫu này. Quyền Git của môi trường phát triển không tự cấp quyền cho website.</p>
    {connections.length ? connections.map(connection => <article className="phase-card" key={connection.id}><strong>{connection.accountLogin}</strong><span>Installation #{connection.installationId}</span>{administrator && <small>Tài khoản được cấp: {users.find(u => u.id === connection.userId)?.email || connection.userId}</small>}<small>{readableDate(connection.createdAt)}</small><button className="button button-outline button-small danger" onClick={async () => {
      if (!window.confirm('Ngắt installation này và gỡ liên kết các repository sử dụng kết nối này?')) return;
      try { await request('/github/connections/' + connection.id, 'DELETE'); await load(); } catch (e) { setError((e as Error).message); }
    }}>Ngắt kết nối GitHub</button></article>) : <p className="phase-empty">Chưa có installation GitHub App được cấp cho tài khoản.</p>}
    {administrator && <details><summary>Cấp installation cho tài khoản</summary><Notice>Máy chủ sẽ xác minh installation qua GitHub App trước khi lưu. Chưa có cấu hình App thì thao tác bị từ chối; không tạo kết nối giả.</Notice><ActionForm submit="Xác minh & cấp installation" onSubmit={async form => {
      await request('/github/connections', 'POST', { installationId: form.get('installationId'), userId: form.get('userId') }); await load();
    }}><label>Installation ID<input name="installationId" inputMode="numeric" pattern="[0-9]{1,20}" maxLength={20} required/></label><label>Tài khoản nhận quyền<select name="userId" required defaultValue={user.id}>{users.map(account => <option key={account.id} value={account.id}>{account.name} · {account.email}</option>)}</select></label></ActionForm></details>}
  </section>;
}

export function ProjectIntegrations({ project, user, initialTab = 'build' }: { project: ProjectAccess; user: any; initialTab?:'build'|'github' }) {
  const [tab, setTab] = useState<'build' | 'github'>(initialTab);
  useEffect(()=>{setTab(initialTab)},[initialTab]);
  function selectTab(next:'build'|'github'){setTab(next);location.hash='projects/'+project.id+'?tab=code&view='+next;}
  if (!canReadSource(project.role)) return <Notice>Vai trò hiện tại không có quyền xem mã nguồn hoặc build riêng của dự án. Dự án công khai không tự công khai mã nguồn.</Notice>;
  return <section className="phase-stack"><div className="phase-subtabs" role="tablist" aria-label="Mã nguồn và build"><button role="tab" aria-selected={tab === 'build'} onClick={() => selectTab('build')}>Build Center</button><button role="tab" aria-selected={tab === 'github'} onClick={() => selectTab('github')}>Source Code · GitHub</button></div>{tab === 'build' ? <BuildCenter key={project.id} project={project} user={user}/> : <Repository key={project.id} project={project} user={user}/>}</section>;
}

function BuildCenter({ project, user }: { project: ProjectAccess; user: any }) {
  const [builds, setBuilds] = useState<Build[]>([]), [releases, setReleases] = useState<any[]>([]), [selected, setSelected] = useState(''), [detail, setDetail] = useState<Build | null>(null), [status, setStatus] = useState<any>(null), [error, setError] = useState('');
  const [startingGame, setStartingGame] = useState(false), [playWhenReady, setPlayWhenReady] = useState('');
  const base = '/projects/' + project.id;
  const writable = canWrite(project), canRun = writable && ['owner', 'manager', 'developer', 'tester'].includes(project.role || ''), canPublish = writable && project.role === 'owner';
  async function load() {
    try { const data = await request(base + '/builds'); setBuilds(data.builds); setReleases(data.releases); setError(''); } catch (e) { setError((e as Error).message); }
  }
  async function loadDetail(id: string) { try { setDetail((await request(base + '/builds/' + id)).build); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void load(); request('/integrations').then(data => setStatus(data.build)).catch(e => setError(e.message)); }, [project.id]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    void loadDetail(selected);
    const timer = setInterval(() => { void load(); void loadDetail(selected); }, 2000);
    return () => clearInterval(timer);
  }, [selected, project.id]);
  const active = detail && !terminal.has(detail.status);
  const canCancel = writable && active && (['owner', 'manager'].includes(project.role || '') || !!user && detail?.authorId === user.id);
  async function createPlayable() {
    setStartingGame(true); setError('');
    try {
      const result = await request(base + '/builds', 'POST', {
        target: 'web', version: 'village-' + Date.now().toString(36),
        files: Object.fromEntries(STARTER_FILES.map(file => [file.path, file.content])),
      });
      setPlayWhenReady(result.build.id); setSelected(result.build.id); setDetail(result.build); await load();
    } catch (e) { setError((e as Error).message); } finally { setStartingGame(false); }
  }
  return <div className="phase-stack"><div><h2>Build Center</h2><p className="hint">Bundle web tĩnh được kiểm tra trong Docker giới hạn tài nguyên, không có mạng và không nhận secret hoặc thư mục của máy chủ. Các tệp JavaScript được kiểm tra cú pháp; tệp <code>*.test.js</code> được chạy thật.</p></div><Notice>{status?.message || 'Đang kiểm tra runner…'}</Notice><ErrorMessage error={error}/>
    {canRun && <details className="studio-example"><summary>Mẫu game để kiểm tra pipeline · Làng Đèn Nhỏ</summary><section className="playable-starter" aria-label="Game làng pixel chơi được"><div className="starter-art" aria-hidden="true"><span>✦</span><span>⌂</span><span>✦</span></div><div className="phase-stack"><div><span className="tag">Game có sẵn · Không cần khóa AI</span><h3>{STARTER_NAME}</h3><p>{STARTER_DESCRIPTION}</p></div><p className="hint">{STARTER_INSTRUCTIONS.join(' · ')}</p><div><button className="button button-primary" disabled={startingGame || !status?.connected} onClick={createPlayable}>{startingGame ? 'Đang tạo bản chơi…' : 'Tạo bản chơi được'}</button></div><small>Mã game và kiểm thử được đóng gói sẵn. Khi build thành công, khung chơi tự mở; bạn cũng có thể tải ZIP để chỉnh sửa.</small>{playWhenReady && detail?.id === playWhenReady && !terminal.has(detail.status) && <p className="hint" role="status">Đang build và kiểm thử game. Khung chơi sẽ mở khi hoàn tất.</p>}</div></section></details>}
    {canRun ? <details><summary>Tạo build web từ mã nguồn</summary><ActionForm submit="Chạy build web cô lập" onSubmit={async form => {
      const files: Record<string, string> = { 'index.html': String(form.get('html')) };
      if (String(form.get('javascript') || '').trim()) files['game.js'] = String(form.get('javascript'));
      if (String(form.get('tests') || '').trim()) files['game.test.js'] = String(form.get('tests'));
      const extras = String(form.get('extras') || '').trim();
      if (extras) {
        let data: unknown;
        try { data = JSON.parse(extras); } catch { throw new Error('Các tệp bổ sung phải là một JSON object hợp lệ.'); }
        if (!data || Array.isArray(data) || typeof data !== 'object' || Object.values(data).some(value => typeof value !== 'string')) throw new Error('Mỗi đường dẫn bổ sung phải có nội dung dạng chuỗi.');
        if (Object.keys(data).some(path => Object.prototype.hasOwnProperty.call(files, path))) throw new Error('Tệp bổ sung trùng với index.html, game.js hoặc game.test.js đã nhập.');
        Object.assign(files, data);
      }
      const result = await request(base + '/builds', 'POST', { target: 'web', version: form.get('version'), files });
      setSelected(result.build.id); setDetail(result.build); await load();
    }}><label>Version build<input name="version" required maxLength={60} pattern="[A-Za-z0-9][A-Za-z0-9._+\-]*" placeholder="0.1.0"/></label><label>index.html<textarea name="html" required rows={7} maxLength={200000} spellCheck={false} placeholder="Mã HTML thực tế của game"/></label><label>game.js · tùy chọn<textarea name="javascript" rows={5} maxLength={200000} spellCheck={false}/></label><label>game.test.js · tùy chọn<textarea name="tests" rows={5} maxLength={200000} spellCheck={false} placeholder="Mã kiểm thử Node.js; assertion thất bại sẽ làm build thất bại."/></label><label>Các tệp bổ sung · JSON object tùy chọn<textarea name="extras" rows={4} maxLength={200000} spellCheck={false} placeholder={'{"style.css":"Nội dung tệp"}'}/></label><Notice>Runner hiện hỗ trợ web tĩnh. Chưa hỗ trợ cài dependency, build Android/Windows/Linux hoặc chạy lệnh shell tùy ý. Artifact là ZIP nguồn đã kiểm tra, không phải APK hay một bản game được triển khai.</Notice>{!status?.connected && <p className="hint">Runner chưa sẵn sàng. Gửi build sẽ trả lỗi cấu hình; không ghi nhận thành công giả.</p>}</ActionForm></details> : <p className="hint">Vai trò hoặc trạng thái khóa hiện tại không cho phép tạo build.</p>}
    <div className="phase-split"><section><h3>Lịch sử build</h3>{builds.length ? builds.map(build => <button className="phase-card" key={build.id} onClick={() => setSelected(build.id)}><strong>{build.version} · {build.target}</strong><span className="tag">{buildLabels[build.status] || build.status}</span><small>{readableDate(build.createdAt)}</small></button>) : <p className="phase-empty">Chưa có build được gửi cho dự án này.</p>}</section><section aria-live="polite">{detail ? <div className="phase-stack"><h3>Build {detail.version}</h3><span className="tag">{buildLabels[detail.status] || detail.status}</span><small>Exit code: {detail.exitCode === null ? 'Chưa có' : detail.exitCode} · {readableDate(detail.finishedAt || detail.startedAt || detail.createdAt)}</small>{canCancel && <button className="button button-outline button-small danger" onClick={async () => { try { await request(base + '/builds/' + detail.id + '/cancel', 'POST'); await loadDetail(detail.id); await load(); } catch (e) { setError((e as Error).message); } }}>Hủy build</button>}<pre className="phase-code" aria-label="Log build">{detail.logs || 'Chưa có log từ runner.'}</pre>{detail.artifact && detail.status === 'succeeded' && <><a className="button button-primary" href={detail.artifact.downloadUrl}>Tải artifact ZIP</a><small>{detail.artifact.size.toLocaleString('vi-VN')} byte</small><code className="preserve-lines">SHA-256: {detail.artifact.sha256}</code><BuildPreview key={detail.id} projectId={project.id} buildId={detail.id} autoLaunch={playWhenReady === detail.id}/></>}{canPublish && detail.status === 'succeeded' && <details><summary>Phê duyệt bản phát hành</summary><ActionForm submit="Lưu bản phát hành đã duyệt" onSubmit={async form => { await request(base + '/releases', 'POST', { buildId: detail.id, version: form.get('version'), changelog: form.get('changelog'), published: form.get('published') === 'on' }); await load(); }}><label>Version phát hành<input name="version" defaultValue={detail.version} required maxLength={60}/></label><label>Changelog<textarea name="changelog" required maxLength={10000} rows={3}/></label><label className="check-row"><input name="published" type="checkbox" disabled={project.visibility !== 'public'}/><span>Công khai bản phát hành{project.visibility !== 'public' && <small>Chủ dự án cần đặt dự án công khai trước khi công khai artifact.</small>}</span></label><Notice>Đây là phê duyệt của chủ dự án. Bản phát hành riêng không cho khách hoặc thành viên chỉ xem quyền tải mã nguồn.</Notice></ActionForm></details>}</div> : <p className="phase-empty">Chọn build để xem log, kết quả kiểm thử và artifact.</p>}</section></div>
    <section><h3>Bản phát hành</h3>{releases.length ? releases.map(release => <article className="phase-card" key={release.id}><strong>{release.version} · {release.published ? 'Công khai' : 'Riêng tư'}</strong><p className="preserve-lines">{release.changelog}</p><small>{readableDate(release.createdAt)}</small><a href={'/api' + base + '/builds/' + release.buildId + '/artifact'}>Tải ZIP của bản phát hành</a></article>) : <p className="hint">Chưa có bản phát hành được chủ dự án phê duyệt.</p>}</section>
  </div>;
}

type PreviewSession = {id:string;url:string;statusUrl:string;expiresAt:string;limitations?:string[]};
function BuildPreview({ projectId, buildId, autoLaunch = false }: {projectId:string;buildId:string;autoLaunch?:boolean}) {
  const [preview,setPreview]=useState<PreviewSession|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[state,setState]=useState('');
  const current=useRef<PreviewSession|null>(null),autoLaunched=useRef(false),mounted=useRef(false);
  const base='/projects/'+projectId+'/builds/'+buildId+'/preview';
  function clearFrame(message='') {current.current=null;setPreview(null);setState(message);}
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const session=current.current;current.current=null;if(session)void request(base+'/'+session.id,'DELETE').catch(()=>{});}},[base]);
  useEffect(()=>{
    if(!preview)return;
    let active=true;
    const tick=async()=>{
      try {
        const result=await request(preview.statusUrl.replace(/^\/api/,''));
        if(!active)return;
        if(!result.preview.active)clearFrame(result.preview.reason==='expired'?'Bản xem trước đã hết hạn.':'Bản xem trước đã bị thu hồi.');
        else setState(result.preview.launched?'Đang chạy trong vùng cô lập.':'Đang mở bản xem trước…');
      } catch(e) {if(active){clearFrame('Không xác nhận được quyền truy cập; đã đóng khung xem trước.');setError((e as Error).message);}}
    };
    void tick();const timer=setInterval(()=>void tick(),1000);
    return()=>{active=false;clearInterval(timer)};
  },[preview?.id]);
  async function launch(){
    setBusy(true);setError('');setState('');
    try {
      const result=await request(base,'POST',{}),next=result.preview as PreviewSession;
      if(!/^\/api\/previews\/[A-Za-z0-9_-]+$/.test(next?.url||'')||!next.statusUrl?.startsWith('/api/projects/'))throw new Error('Đường dẫn preview trả về không hợp lệ.');
      if(!mounted.current){void request(base+'/'+next.id,'DELETE').catch(()=>{});return;}
      current.current=next;setPreview(next);
    } catch(e){setError((e as Error).message)} finally{setBusy(false)}
  }
  useEffect(()=>{if(autoLaunch&&!autoLaunched.current){autoLaunched.current=true;void launch();}},[autoLaunch]);
  async function close(){const session=current.current;clearFrame('Đã đóng bản xem trước.');if(session)try{await request(base+'/'+session.id,'DELETE')}catch(e){setError((e as Error).message)}}
  return <section className="phase-stack" aria-label="Bản xem trước game cô lập"><h4>Xem trước game web</h4><Notice>Game mở trong vùng cô lập của trình duyệt, tách khỏi cookie và dữ liệu tài khoản. Tài nguyên mạng, cửa sổ phụ và quyền thiết bị bị giới hạn; hãy đọc các giới hạn trả về trước khi thử. Chỉ hỗ trợ bundle tự chứa. URL dùng một lần và có thời hạn.</Notice><ErrorMessage error={error}/>{preview ? <><div className="phase-inline"><button className="button button-outline button-small" onClick={close}>Đóng bản xem trước</button><small>Hết hạn: {readableDate(preview.expiresAt)}</small></div><iframe key={preview.id} title="Bản xem trước game web cô lập" src={preview.url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="build-game-frame"/>{preview.limitations?.map((text,index)=><small key={index}>{text}</small>)}</> : <button className="button button-outline" disabled={busy} onClick={launch}>{busy?'Đang cấp quyền preview…':'Mở bản xem trước cô lập'}</button>}{state&&<p className="hint" role="status">{state}</p>}</section>;
}

function Repository({ project, user }: { project: ProjectAccess; user: any }) {
  const [repository, setRepository] = useState<any>(null), [connections, setConnections] = useState<Connection[]>([]), [proposals, setProposals] = useState<any[]>([]), [configuration, setConfiguration] = useState<any>(null), [error, setError] = useState('');
  const [view, setView] = useState('commits'), [result, setResult] = useState<any>(null), [loading, setLoading] = useState(false);
  const [workspaces,setWorkspaces]=useState<any[]>([]),[workspaceId,setWorkspaceId]=useState(''),[workspaceDetail,setWorkspaceDetail]=useState<any>(null),[validationBuild,setValidationBuild]=useState<any>(null),[busy,setBusy]=useState('');
  const projectBase='/projects/'+project.id, base=projectBase+'/repository', writable=canWrite(project), owner=project.role==='owner', canPropose=writable&&['owner','manager','developer'].includes(project.role||'');
  async function load(background=false) {
    try {
      const [data,list,status,snapshots]=await Promise.all([request(base),request('/github/connections'),request('/integrations'),request(projectBase+'/workspaces')]);
      setRepository(data.repository);setProposals(data.proposals);setConnections(list.connections.filter((connection:Connection)=>connection.userId===user?.id));setConfiguration(status.github);setWorkspaces(snapshots.workspaces);if(!background)setError('');
    } catch(e) {setError((e as Error).message);setRepository(null);setProposals([]);setWorkspaces([]);setWorkspaceDetail(null);setValidationBuild(null);setResult(null);}
  }
  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),3000);return()=>clearInterval(timer)},[project.id,user?.id]);
  async function selectWorkspace(id:string){
    setWorkspaceId(id);setWorkspaceDetail(null);
    if(!id)return;
    try {setWorkspaceDetail(await request(projectBase+'/workspaces/'+id))}catch(e){setError((e as Error).message)}
  }
  async function read(path:string){setLoading(true);setError('');try{setResult((await request(base+path)).data)}catch(e){setError((e as Error).message);setResult(null)}finally{setLoading(false)}}
  async function validate(proposal:any){
    const selected=proposal.workspaceId||workspaceId;
    if(!selected){setError('Chọn một snapshot gốc trước khi kiểm thử đề xuất.');return}
    setBusy(proposal.id);setError('');
    try {const data=await request(base+'/proposals/'+proposal.id+'/validate','POST',{workspaceId:selected});setValidationBuild(data.build);await load()}
    catch(e){setError((e as Error).message)}finally{setBusy('')}
  }
  async function showValidation(proposal:any){
    try {const data=await request(projectBase+'/builds/'+proposal.validationBuildId);setValidationBuild(data.build)}catch(e){setError((e as Error).message)}
  }
  return <div className="phase-stack"><h2>Source Code · GitHub</h2><Notice>{configuration?.message || 'Đang kiểm tra cấu hình GitHub App…'}</Notice><ErrorMessage error={error}/>{repository ? <article className="phase-card"><strong>{repository.owner}/{repository.repository}</strong><span>Nhánh mặc định: {repository.branch}</span><small>Cập nhật: {readableDate(repository.updatedAt)}</small><a href={'https://github.com/'+encodeURIComponent(repository.owner)+'/'+encodeURIComponent(repository.repository)} rel="noreferrer" target="_blank">Mở repository trên GitHub</a></article> : <p className="phase-empty">Dự án chưa liên kết repository. Chưa có dữ liệu commit hoặc Pull Request từ GitHub.</p>}
    {owner&&writable&&<details><summary>{repository?'Cập nhật repository liên kết':'Liên kết repository được cấp quyền'}</summary>{!connections.length&&<Notice>Chưa có installation được cấp cho tài khoản. Quản trị viên cấu hình và cấp GitHub App trong Cài đặt trước.</Notice>}<ActionForm submit="Xác minh & liên kết repository" onSubmit={async form=>{await request(base,'POST',Object.fromEntries(form));setResult(null);await load()}}><label>Kết nối GitHub được cấp<select name="connectionId" required><option value="">Chọn installation</option>{connections.map(connection=><option key={connection.id} value={connection.id}>{connection.accountLogin} · #{connection.installationId}</option>)}</select></label><div className="form-columns"><label>Owner repository<input name="owner" required maxLength={100} pattern="[A-Za-z0-9_.\-]+" defaultValue={repository?.owner||''}/></label><label>Tên repository<input name="repository" required maxLength={100} pattern="[A-Za-z0-9_.\-]+" defaultValue={repository?.repository||''}/></label></div><label>Nhánh mặc định<input name="branch" required maxLength={100} defaultValue={repository?.branch||'main'}/></label><p className="hint">Máy chủ kiểm tra quyền installation và repository/nhánh trước khi lưu.</p></ActionForm></details>}
    <section className="phase-stack" aria-label="Workspace mã nguồn bất biến"><h3>Snapshot & workspace kiểm thử</h3><Notice>Snapshot giữ mã nguồn tại đúng commit và checksum. Kiểm thử PR phải dùng snapshot GitHub phù hợp; snapshot local chỉ dùng kiểm tra nội dung, không chứng minh quyền repository và không thể tự tạo PR.</Notice>
      {writable&&<>{repository&&<ActionForm submit="Chụp snapshot GitHub được cấp quyền" onSubmit={async form=>{const data=await request(projectBase+'/workspaces','POST',{source:'github',base:form.get('base')});await load();await selectWorkspace(data.workspace.id)}}><label>Nhánh snapshot GitHub<input name="base" defaultValue={repository.branch} required maxLength={100}/></label></ActionForm>}<details><summary>Tạo snapshot local từ mã nguồn được cung cấp</summary><ActionForm submit="Lưu snapshot local" onSubmit={async form=>{let files:unknown;try{files=JSON.parse(String(form.get('sourceFiles')))}catch{throw new Error('Mã nguồn snapshot phải là JSON object hợp lệ.')}if(!files||Array.isArray(files)||typeof files!=='object'||Object.values(files).some(value=>typeof value!=='string'))throw new Error('Nhập map đường dẫn → nội dung văn bản.');const data=await request(projectBase+'/workspaces','POST',{source:'local',files});await load();await selectWorkspace(data.workspace.id)}}><label>Các tệp snapshot local · JSON object<textarea name="sourceFiles" required rows={5} maxLength={200000} spellCheck={false} placeholder={'{"index.html":"...","game.js":"...","game.test.js":"..."}'}/></label></ActionForm></details></>}
      <label>Workspace gốc để xem hoặc kiểm thử<select value={workspaceId} onChange={e=>void selectWorkspace(e.target.value)}><option value="">Chọn snapshot</option>{workspaces.map(workspace=><option key={workspace.id} value={workspace.id}>{workspace.source} · {workspace.base||'local'} · {workspace.fileCount} tệp · {readableDate(workspace.createdAt)}</option>)}</select></label>
      {workspaceDetail&&<article className="phase-card"><strong>Snapshot {workspaceDetail.workspace.source}</strong><span>{workspaceDetail.workspace.fileCount} tệp · {workspaceDetail.workspace.totalBytes} byte</span><code className="preserve-lines">Commit: {workspaceDetail.workspace.baseCommit||'Không có commit GitHub'}</code><code className="preserve-lines">SHA-256 manifest: {workspaceDetail.workspace.manifestHash}</code><span>{workspaceDetail.workspace.staticSupported?'Phù hợp runner web tĩnh':'Chưa hỗ trợ kiểm thử bằng runner web tĩnh hiện tại'}</span>{workspaceDetail.workspace.excludedPaths?.length>0&&<details><summary>Các đường dẫn bị loại khỏi snapshot</summary><pre className="phase-code">{workspaceDetail.workspace.excludedPaths.join('\n')}</pre></details>}<details><summary>Xem các tệp snapshot · {Object.keys(workspaceDetail.files||{}).length}</summary>{Object.entries(workspaceDetail.files||{}).map(([path,content])=><section key={path}><h4>{path}</h4><pre className="phase-code">{String(content)}</pre></section>)}</details></article>}
    </section>
    {repository&&<><div className="phase-subtabs" role="tablist" aria-label="Dữ liệu GitHub">{[['commits','Commits'],['tree','Cây tệp'],['file','Đọc tệp'],['diff','So sánh'],['pulls','Pull Requests']].map(([key,label])=><button role="tab" aria-selected={view===key} key={key} onClick={()=>{setView(key);setResult(null)}}>{label}</button>)}</div>{['commits','tree','pulls'].includes(view)?<button className="button button-outline" disabled={loading} onClick={()=>read('/'+view)}>{loading?'Đang đọc GitHub…':'Đọc '+({commits:'commits',tree:'cây tệp',pulls:'Pull Requests'} as any)[view]+' từ GitHub'}</button>:<ActionForm submit={view==='file'?'Đọc tệp từ GitHub':'So sánh commit / nhánh'} onSubmit={async form=>{const query=new URLSearchParams(Object.fromEntries(form) as Record<string,string>);await read('/'+view+'?'+query)}}>{view==='file'?<><label>Đường dẫn tệp<input name="path" required maxLength={200} placeholder="src/game.js"/></label><label>Nhánh<input name="ref" required defaultValue={repository.branch}/></label></>:<><label>Base<input name="base" required defaultValue={repository.branch}/></label><label>Head<input name="head" required/></label></>}</ActionForm>}{result!==null&&<GitHubResult view={view} data={result}/>}
      {canPropose&&<details><summary>Tạo đề xuất thay đổi mã nguồn</summary><Notice>Thay đổi được lưu tại đây. Chỉ được tạo nhánh/commit/PR sau kiểm thử thành công của đúng snapshot, mã nguồn và commit gốc, rồi chủ dự án phê duyệt.</Notice><ActionForm key={repository.branch+workspaceId} submit="Lưu đề xuất chờ duyệt" onSubmit={async form=>{let files:unknown;try{files=JSON.parse(String(form.get('files')))}catch{throw new Error('Danh sách tệp phải là JSON hợp lệ.')}if(!Array.isArray(files)||!files.length||files.some(file=>!file||typeof file.path!=='string'||typeof file.content!=='string'))throw new Error('Nhập mảng [{path, content}] có ít nhất một tệp.');await request(base+'/proposals','POST',{branch:form.get('branch'),base:form.get('base'),title:form.get('title'),body:form.get('body'),workspaceId:workspaceId||undefined,files});await load()}}><label>Tiêu đề Pull Request<input name="title" required minLength={2} maxLength={200}/></label><div className="form-columns"><label>Nhánh thay đổi mới<input name="branch" required maxLength={100} placeholder="pixel/ten-thay-doi"/></label><label>Base<input name="base" required defaultValue={workspaceDetail?.workspace?.source==='github'?workspaceDetail.workspace.base:repository.branch}/></label></div><label>Mô tả thay đổi<textarea name="body" maxLength={10000} rows={3}/></label><label>Các tệp đề xuất · JSON<textarea name="files" required rows={6} maxLength={200000} spellCheck={false} placeholder={'[{"path":"game.js","content":"Nội dung đầy đủ của tệp"}]'}/></label><small>Workspace đã chọn: {workspaceId||'Chưa chọn; phải chọn trước khi kiểm thử'}</small></ActionForm></details>}
      <section><h3>Đề xuất & phê duyệt</h3><Notice>Kiểm thử PR cần bundle web tự chứa và ít nhất một tệp *.test.js. Runner không cài dependency hoặc xác nhận mọi framework; build không đạt sẽ chặn tạo PR.</Notice>{proposals.length?proposals.map(proposal=><article className="phase-card" key={proposal.id}><strong>{proposal.title}</strong><span>{proposal.base} → {proposal.branch} · {proposal.status}</span><p className="preserve-lines">{proposal.body}</p>{proposal.error&&<ErrorMessage error={proposal.error}/>}<small>{readableDate(proposal.createdAt)}</small>{proposal.baseCommit&&<code className="preserve-lines">Commit gốc: {proposal.baseCommit}</code>}<span>Kiểm thử: {proposal.validationStatus||'Chưa chạy'}</span>{proposal.validationHash&&<code className="preserve-lines">SHA-256 nguồn đã kiểm tra: {proposal.validationHash}</code>}{proposal.files&&<details><summary>Xem các tệp thay đổi trước khi duyệt · {proposal.files.length}</summary>{proposal.files.map((file:any)=><section key={file.path}><h4>{file.path}</h4>{workspaceDetail?.workspace?.id===proposal.workspaceId&&<><h5>Bản gốc</h5><pre className="phase-code">{workspaceDetail.files?.[file.path]??'(Tệp mới)'}</pre></>}<h5>Bản đề xuất</h5><pre className="phase-code">{file.content}</pre></section>)}</details>}{proposal.pullUrl&&<a target="_blank" rel="noreferrer" href={proposal.pullUrl}>Xem Pull Request thật</a>}
        {proposal.validationBuildId&&<button className="button button-outline button-small" onClick={()=>void showValidation(proposal)}>Xem log kiểm thử đề xuất</button>}{canPropose&&proposal.status==='pending'&&<button className="button button-outline" disabled={!!busy||['queued','preparing','building','testing'].includes(proposal.validationStatus)} onClick={()=>void validate(proposal)}>{busy===proposal.id?'Đang tạo lượt kiểm thử…':'Kiểm thử mã nguồn đề xuất'}</button>}{owner&&writable&&proposal.status==='pending'&&<><button className="button button-primary" disabled={proposal.validationStatus!=='succeeded'} onClick={async()=>{if(!window.confirm('Phê duyệt mã nguồn đã kiểm thử để tạo nhánh mới, commit và Pull Request trên GitHub? Không merge hoặc ghi vào nhánh mặc định.'))return;try{await request(base+'/proposals/'+proposal.id+'/approve','POST');await load()}catch(e){await load();setError((e as Error).message)}}}>Phê duyệt & tạo Pull Request</button>{proposal.validationStatus!=='succeeded'&&<small>Chỉ duyệt được sau khi kiểm thử thành công. Máy chủ vẫn xác minh checksum và commit gốc tại thời điểm ghi GitHub.</small>}</>}
      </article>):<p className="hint">Chưa có đề xuất thay đổi.</p>}</section></>}
    {validationBuild&&<section className="phase-card" aria-label="Kết quả kiểm thử đề xuất"><h3>Build kiểm thử {validationBuild.version}</h3><span>{buildLabels[validationBuild.status]||validationBuild.status} · Exit code: {validationBuild.exitCode??'Chưa có'}</span><pre className="phase-code">{validationBuild.logs||'Chưa có log. Dùng nút xem log để đọc kết quả mới nhất.'}</pre></section>}
  </div>;
}

function GitHubResult({ view, data }: { view: string; data: any }) {
  if (view === 'file' && data?.encoding === 'base64' && typeof data.content === 'string') {
    let content = '';
    try { const raw = atob(data.content.replace(/\s/g,'')); content = new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(raw, char => char.charCodeAt(0))); } catch { return <Notice>Tệp không phải văn bản UTF-8 có thể hiển thị. Nội dung nhị phân không được thực thi trong trang này.</Notice>; }
    return <section className="phase-stack"><h3>{data.path || data.name}</h3><pre className="phase-code">{content}</pre></section>;
  }
  if (view === 'commits' && Array.isArray(data)) return <div className="phase-stack">{data.length ? data.map(commit => <article className="phase-card" key={commit.sha}><strong>{commit.commit?.message}</strong><code>{commit.sha}</code><small>{commit.commit?.author?.name} · {readableDate(commit.commit?.author?.date)}</small>{commit.html_url && <a href={commit.html_url} rel="noreferrer" target="_blank">Xem commit</a>}</article>) : <p className="hint">GitHub chưa trả commit nào.</p>}</div>;
  if (view === 'tree') return <section><h3>Cây tệp</h3>{data?.truncated && <Notice>Kết quả GitHub đã bị giới hạn; cây tệp này chưa đầy đủ.</Notice>}<pre className="phase-code">{data?.tree?.map((file:any) => `${file.type === 'tree' ? '▸ ' : '  '}${file.path}`).join('\n') || 'Không có tệp trong kết quả.'}</pre></section>;
  if (view === 'pulls' && Array.isArray(data)) return <div className="phase-stack">{data.length ? data.map(pull => <article className="phase-card" key={pull.id}><strong>#{pull.number} {pull.title}</strong><span>{pull.state} · {pull.user?.login}</span><a href={pull.html_url} target="_blank" rel="noreferrer">Mở Pull Request</a></article>) : <p className="hint">Chưa có Pull Request từ GitHub.</p>}</div>;
  if (view === 'diff') return <div className="phase-stack"><p>{data?.status} · {data?.ahead_by || 0} commit phía trước · {data?.behind_by || 0} commit phía sau</p>{data?.files?.map((file:any) => <article key={file.filename}><h3>{file.filename}</h3><p>{file.status} · +{file.additions} / −{file.deletions}</p><pre className="phase-code">{file.patch || 'GitHub không trả patch văn bản cho tệp này.'}</pre></article>)}</div>;
  return <pre className="phase-code">{JSON.stringify(data,null,2)}</pre>;
}
