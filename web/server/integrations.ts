import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { z } from 'zod';
import type { ModuleContext, Row } from './context.js';
import { HttpError } from './context.js';
import { GitHubClient, githubStatus, verifyWebhook, safeBranch, safeRepositoryPath, type GitHubConfig } from './github.js';
import { dockerAvailable, runWebBuild, validateSourceFiles, type BuildResult } from './build-runner.js';
import { getAIStatus } from './ai.js';
import { projectPermissions } from './projects.js';
import { captureGitHubWorkspace, persistWorkspace, workspaceShape, sourceHash, mergedProposalFiles, validateWorkspaceFiles } from './source-workspace.js';

export interface ApprovedIntegrationAction {id:string;jobId?:string;projectId:string;type:'request_build'|'propose_source_change';arguments:{files:Record<string,string>;version?:string;branch?:string;base?:string;title?:string;body?:string;workspaceId?:string};}
export interface IntegrationOptions { github?:GitHubConfig; runBuild?:typeof runWebBuild; autoRun?:boolean; runnerEnabled?:boolean; }
const now=()=>new Date().toISOString();
const repoName=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/);
const branch=z.string().refine(safeBranch,'Nhánh không hợp lệ.');
const version=z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

export function registerIntegrations(ctx:ModuleContext,options:IntegrationOptions={}) {
  const {app,one,all,run,route,authenticated,uid,getProject,ownProject,audit,notify,transaction}=ctx;
  const github=new GitHubClient(ctx,options.github),running=new Map<string,AbortController>();
  let closed=false;
  const enabled=options.runnerEnabled??(!!options.runBuild||process.env.BUILD_RUNNER_ENABLED==='true');
  const runnerReady=options.runBuild?Promise.resolve(true):enabled?dockerAvailable():Promise.resolve(false);
  const admin=(user:Row)=>JSON.parse(user.roles).includes('admin');
  const connectionShape=(c:Row)=>({id:c.id,userId:c.user_id,installationId:c.installation_id,accountLogin:c.account_login,createdAt:c.created_at});
  const proposalShape=(p:Row)=>({id:p.id,projectId:p.project_id,branch:p.branch,base:p.base,title:p.title,body:p.body,status:p.status,pullUrl:p.pull_url,error:p.error,createdAt:p.created_at,approvedAt:p.approved_at,workspaceId:p.workspace_id,baseCommit:p.source_base_commit,validationBuildId:p.validation_build_id,validationHash:p.validation_hash,files:JSON.parse(p.files_json),validationStatus:p.validation_build_id?one('SELECT status FROM build_jobs WHERE id=?',p.validation_build_id)?.status:null});
  const memberProject=(id:string,res:any)=>{const p=getProject(id,res);if(!projectPermissions(p.role,!!p.locked).viewSource)throw new HttpError(403,'Vai trò này không có quyền xem mã nguồn và bản build riêng.');return p;};
  const linkAndConnection=(id:string,res:any)=>{memberProject(id,res);const link=one('SELECT * FROM repository_links WHERE project_id=?',id);if(!link)throw new HttpError(404,'Dự án chưa liên kết repository.');const connection=one('SELECT * FROM github_connections WHERE id=?',link.connection_id);if(!connection)throw new HttpError(503,'Kết nối repository không còn hoạt động.');return{link,connection};};
  const buildShape=(b:Row)=>({id:b.id,projectId:b.project_id,authorId:b.author_id,target:b.target,version:b.version,status:b.status,logs:b.logs,exitCode:b.exit_code,artifact:b.artifact_path?{sha256:b.artifact_hash,size:b.artifact_size,downloadUrl:`/api/projects/${b.project_id}/builds/${b.id}/artifact`}:null,createdAt:b.created_at,startedAt:b.started_at,finishedAt:b.finished_at});
  const getBuild=(projectId:string,id:string)=>{const b=one('SELECT * FROM build_jobs WHERE project_id=? AND id=?',projectId,id);if(!b)throw new HttpError(404,'Không có bản build này.');return b;};
  const releaseShape=(r:Row)=>({id:r.id,buildId:r.build_id,projectId:r.project_id,version:r.version,changelog:r.changelog,published:!!r.published,createdAt:r.created_at});

  // A request in flight at restart has an uncertain external outcome. Preserve
  // the evidence and require a fresh explicit job rather than silently rerun.
  run("UPDATE build_jobs SET status='failed',logs=logs||?,finished_at=? WHERE status IN ('queued','preparing','building','testing')",'\nServer restarted while build was incomplete. Submit a new build explicitly.',now());
  run("UPDATE github_proposals SET status='failed',error=? WHERE status='running'",'Server restarted during GitHub operation; inspect repository before creating a new proposal.');

  app.get('/api/integrations',route(async(_req,res)=>res.json({ai:getAIStatus(),github:githubStatus(options.github),build:{connected:enabled&&await runnerReady,status:enabled&&await runnerReady?'configured':'not_configured',targets:['web'],unsupportedTargets:['android','windows','linux'],message:enabled&&await runnerReady?'Runner Docker giới hạn tài nguyên, không có mạng. Chỉ hỗ trợ bundle web tĩnh, kiểm tra cú pháp JavaScript và các tệp *.test.js.':'Runner Docker chưa được bật hoặc không truy cập được. Cần BUILD_RUNNER_ENABLED=true và image node:24-bookworm-slim đã được cài.'}})));
  app.get('/api/github/connections',authenticated,route((_req,res)=>res.json({connections:(admin(res.locals.user)?all('SELECT * FROM github_connections ORDER BY created_at DESC'):all('SELECT * FROM github_connections WHERE user_id=? ORDER BY created_at DESC',uid(res))).map(connectionShape)})));
  app.post('/api/github/connections',authenticated,route(async(req,res)=>{
    if(!admin(res.locals.user))throw new HttpError(403,'Quản trị viên phải cấp installation cho tài khoản.');
    const d=z.object({installationId:z.string().regex(/^\d{1,20}$/),userId:z.string().uuid()}).parse(req.body);
    if(!one('SELECT id FROM users WHERE id=?',d.userId))throw new HttpError(404,'Tài khoản không tồn tại.');
    if(one('SELECT id FROM github_connections WHERE user_id=? AND installation_id=?',d.userId,d.installationId))throw new HttpError(409,'Installation đã được cấp cho tài khoản này.');
    const installation=await github.inspectInstallation(d.installationId);
    if(installation.suspended_at||!installation.account?.login)throw new HttpError(403,'Installation không hoạt động.');
    const id=randomUUID();run('INSERT INTO github_connections(id,user_id,installation_id,account_login,created_at) VALUES(?,?,?,?,?)',id,d.userId,d.installationId,installation.account.login,now());audit(uid(res),null,'github.installation_granted',d.userId);
    res.status(201).json({connection:connectionShape(one('SELECT * FROM github_connections WHERE id=?',id)!)});
  }));
  app.delete('/api/github/connections/:connectionId',authenticated,route((req,res)=>{
    const c=one('SELECT * FROM github_connections WHERE id=?',String(req.params.connectionId));if(!c||c.user_id!==uid(res)&&!admin(res.locals.user))throw new HttpError(404,'Không có kết nối này.');
    transaction(()=>{run('DELETE FROM repository_links WHERE connection_id=?',c.id);run('DELETE FROM github_connections WHERE id=?',c.id);audit(uid(res),null,'github.disconnected',c.id);});res.json({ok:true});
  }));
  app.get('/api/projects/:id/repository',authenticated,route((req,res)=>{memberProject(String(req.params.id),res);const r=one('SELECT * FROM repository_links WHERE project_id=?',String(req.params.id));res.json({repository:r?{connectionId:r.connection_id,owner:r.owner,repository:r.repository,branch:r.branch,updatedAt:r.updated_at}:null,proposals:all('SELECT * FROM github_proposals WHERE project_id=? ORDER BY created_at DESC LIMIT 100',String(req.params.id)).map(proposalShape)});}));
  app.post('/api/projects/:id/repository',authenticated,route(async(req,res)=>{
    const p=getProject(String(req.params.id),res);if(!projectPermissions(p.role,!!p.locked).connectRepository)throw new HttpError(403,'Chỉ chủ dự án có quyền kết nối repository khi được phép sửa.');const d=z.object({connectionId:z.string().uuid(),owner:repoName,repository:repoName,branch}).parse(req.body);
    const c=one('SELECT * FROM github_connections WHERE id=? AND user_id=?',d.connectionId,uid(res));if(!c)throw new HttpError(403,'Kết nối chưa được cấp cho chủ dự án.');
    const result=await github.repository(c,d.owner,d.repository);await github.request(`/repos/${encodeURIComponent(d.owner)}/${encodeURIComponent(d.repository)}/git/ref/heads/${encodeURIComponent(d.branch)}`,result.token);
    run('INSERT INTO repository_links(project_id,connection_id,owner,repository,branch,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET connection_id=excluded.connection_id,owner=excluded.owner,repository=excluded.repository,branch=excluded.branch,updated_at=excluded.updated_at',p.id,c.id,d.owner,d.repository,d.branch,now());audit(uid(res),p.id,'github.repository_linked',`${d.owner}/${d.repository}`);res.json({repository:{...d,projectId:p.id}});
  }));
  for(const view of ['tree','file','commits','diff','pulls'])app.get(`/api/projects/:id/repository/${view}`,authenticated,route(async(req,res)=>{
    const {link,connection}=linkAndConnection(String(req.params.id),res),token=await github.token(connection),prefix=`/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}`;
    const ref=typeof req.query.ref==='string'?branch.parse(req.query.ref):link.branch;let path='';
    const page=z.coerce.number().int().min(1).max(100).parse(req.query.page??1);
    if(view==='tree')path=`/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    if(view==='file'){const source=z.string().refine(safeRepositoryPath).parse(req.query.path);path='/contents/'+source.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(ref);}
    if(view==='commits')path=`/commits?sha=${encodeURIComponent(ref)}&per_page=50&page=${page}`;
    if(view==='pulls')path=`/pulls?state=all&per_page=50&page=${page}`;
    if(view==='diff'){const base=branch.parse(req.query.base??link.branch),head=branch.parse(req.query.head);path=`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;}
    res.json({data:await github.request(prefix+path,token)});
  }));
  const currentActor = (projectId:string, actorId:string, ownerOnly=false) => {
    if(closed)throw new HttpError(503,'Dịch vụ đang dừng.');
    const p=one('SELECT p.*,m.role FROM projects p JOIN project_members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=? AND p.deleted_at IS NULL',actorId,projectId);
    if(!p||!projectPermissions(p.role,!!p.locked).viewSource||(p.locked&&p.role!=='owner')||(ownerOnly&&(p.role!=='owner'||p.locked)))throw new HttpError(403,'Không còn quyền thực hiện thao tác mã nguồn của dự án.');
    return p;
  };
  const currentLink = (projectId:string) => {
    const link=one('SELECT * FROM repository_links WHERE project_id=?',projectId);
    if(!link)throw new HttpError(404,'Dự án chưa liên kết repository.');
    return link;
  };
  const getWorkspace = (projectId:string,id:string) => {
    const workspace=one('SELECT * FROM source_workspaces WHERE project_id=? AND id=?',projectId,id);
    if(!workspace)throw new HttpError(404,'Workspace không tồn tại.');
    return workspace;
  };
  const matchesLink = (workspace:Row,link:Row,base:string) => workspace.source==='github'&&workspace.repository_owner===link.owner&&workspace.repository_name===link.repository&&workspace.base_branch===base;
  const proposalInput=z.object({branch,base:branch,title:z.string().trim().min(2).max(200),body:z.string().max(10000),workspaceId:z.string().uuid().optional(),files:z.array(z.object({path:z.string().refine(safeRepositoryPath),content:z.string().max(100000)})).min(1).max(30)});
  function saveProposal(projectId:string,actorId:string,input:unknown,tool?:{id:string;hash:string}) {
    const p=currentActor(projectId,actorId,!!tool);if(!projectPermissions(p.role,!!p.locked).editSource)throw new HttpError(403,'Không có quyền đề xuất mã nguồn.');
    const d=proposalInput.parse(input),link=currentLink(projectId);
    if(['main','master',link.branch,d.base].includes(d.branch))throw new HttpError(400,'Cần một nhánh thay đổi riêng.');
    if(new Set(d.files.map(file=>file.path)).size!==d.files.length)throw new HttpError(400,'Đề xuất có đường dẫn lặp.');
    validateWorkspaceFiles(Object.fromEntries(d.files.map(file=>[file.path,file.content])));
    const workspace=d.workspaceId?getWorkspace(projectId,d.workspaceId):undefined;
    if(workspace&&!matchesLink(workspace,link,d.base))throw new HttpError(409,'Workspace không khớp repository/nhánh của đề xuất.');
    if(tool){const prior=one('SELECT * FROM github_proposals WHERE tool_action_id=?',tool.id);if(prior){if(prior.project_id!==projectId||prior.tool_action_hash!==tool.hash||prior.author_id!==actorId)throw new HttpError(409,'Mã thao tác đã được dùng cho nội dung khác.');return prior;}}
    const id=randomUUID();
    transaction(()=>{currentActor(projectId,actorId,!!tool);run('INSERT INTO github_proposals(id,project_id,author_id,branch,base,title,body,files_json,status,created_at,workspace_id,source_base_commit,tool_action_id,tool_action_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,projectId,actorId,d.branch,d.base,d.title,d.body,JSON.stringify(d.files),'pending',now(),workspace?.id||null,workspace?.base_commit||null,tool?.id||null,tool?.hash||null);audit(actorId,projectId,'github.proposal_created',id);});
    return one('SELECT * FROM github_proposals WHERE id=?',id)!;
  }
  app.get('/api/projects/:id/workspaces',authenticated,route((req,res)=>{const p=memberProject(String(req.params.id),res);res.json({workspaces:all('SELECT * FROM source_workspaces WHERE project_id=? ORDER BY created_at DESC LIMIT 100',p.id).map(workspaceShape)});}));
  app.post('/api/projects/:id/workspaces',authenticated,route(async(req,res)=>{
    const p=currentActor(String(req.params.id),uid(res));
    const d=z.object({source:z.enum(['github','local']),base:branch.optional(),files:z.record(z.string(),z.string()).optional()}).parse(req.body);
    let workspace:Row;
    if(d.source==='local'){validateWorkspaceFiles(d.files);workspace=await persistWorkspace(ctx,{projectId:p.id,userId:uid(res),source:'local',files:d.files});}
    else{const {link,connection}=linkAndConnection(p.id,res);workspace=await captureGitHubWorkspace(ctx,github,link,connection,d.base||link.branch,uid(res));}
    res.status(201).json({workspace:workspaceShape(workspace)});
  }));
  app.get('/api/projects/:id/workspaces/:workspaceId',authenticated,route((req,res)=>{const p=memberProject(String(req.params.id),res),workspace=getWorkspace(p.id,String(req.params.workspaceId));res.json({workspace:workspaceShape(workspace),files:JSON.parse(workspace.files_json)});}));
  app.post('/api/projects/:id/repository/proposals',authenticated,route((req,res)=>{const proposal=saveProposal(String(req.params.id),uid(res),req.body);res.status(201).json({proposal:proposalShape(proposal)});}));
  function verifyProposalValidation(proposal:Row,link:Row) {
    if(!proposal.workspace_id||!proposal.validation_build_id||!proposal.validation_hash)throw new HttpError(409,'Cần snapshot và kiểm thử mã nguồn trước khi phê duyệt PR.','VALIDATION_REQUIRED');
    const workspace=getWorkspace(proposal.project_id,proposal.workspace_id);
    if(!matchesLink(workspace,link,proposal.base)||workspace.base_commit!==proposal.source_base_commit)throw new HttpError(409,'Snapshot không còn khớp repository/nhánh.','VALIDATION_STALE');
    const files=mergedProposalFiles(workspace,JSON.parse(proposal.files_json)),hash=sourceHash(files),build=getBuild(proposal.project_id,proposal.validation_build_id);
    if(hash!==proposal.validation_hash||build.source_hash!==hash||build.workspace_id!==workspace.id||sourceHash(JSON.parse(build.files_json))!==hash)throw new HttpError(409,'Kết quả kiểm thử không khớp chính xác mã nguồn đề xuất.','VALIDATION_STALE');
    if(build.status!=='succeeded'||build.exit_code!==0||!build.artifact_path||!existsSync(build.artifact_path))throw new HttpError(409,'Build kiểm thử chưa thành công; không được tạo PR.','VALIDATION_FAILED');
    const artifactRoot=resolve(ctx.dataDir,'artifacts'),artifactPath=resolve(build.artifact_path),artifactRelative=relative(artifactRoot,artifactPath);
    if(!artifactRelative||artifactRelative.startsWith('..')||artifactRelative.includes('/')||artifactRelative.includes('\\')||artifactRelative!==build.id+'.zip')throw new HttpError(409,'Artifact kiểm thử không hợp lệ.','VALIDATION_FAILED');
    const artifact=readFileSync(artifactPath);
    if(artifact.length!==build.artifact_size||createHash('sha256').update(artifact).digest('hex')!==build.artifact_hash)throw new HttpError(409,'Checksum artifact kiểm thử không khớp.','VALIDATION_FAILED');
    if(!Object.keys(files).some(path=>/\.test\.(?:js|mjs|cjs)$/.test(path)))throw new HttpError(409,'Snapshot cần có tệp kiểm thử JavaScript.','TESTS_REQUIRED');
    return {workspace,files,build};
  }
  app.post('/api/projects/:id/repository/proposals/:proposalId/validate',authenticated,route(async(req,res)=>{
    const p=currentActor(String(req.params.id),uid(res));
    if(!projectPermissions(p.role,!!p.locked).runBuild)throw new HttpError(403,'Không có quyền kiểm thử mã nguồn.');
    const proposal=one('SELECT * FROM github_proposals WHERE id=? AND project_id=?',String(req.params.proposalId),p.id);
    if(!proposal||proposal.status!=='pending')throw new HttpError(409,'Chỉ kiểm thử đề xuất đang chờ phê duyệt.');
    const d=z.object({workspaceId:z.string().uuid().optional()}).parse(req.body||{}),workspace=getWorkspace(p.id,d.workspaceId||proposal.workspace_id||'');
    if(!matchesLink(workspace,currentLink(p.id),proposal.base))throw new HttpError(409,'Snapshot không khớp repository/nhánh của đề xuất.');
    const files=mergedProposalFiles(workspace,JSON.parse(proposal.files_json));
    if(!Object.keys(files).some(path=>/\.test\.(?:js|mjs|cjs)$/.test(path)))throw new HttpError(409,'Thêm tệp *.test.js để kiểm thử trước khi tạo PR.','TESTS_REQUIRED');
    const build=await queueBuild(p.id,uid(res),files,'validate-'+proposal.id.slice(0,8),{workspaceId:workspace.id});
    run("UPDATE github_proposals SET workspace_id=?,source_base_commit=?,validation_build_id=?,validation_hash=? WHERE id=? AND status='pending'",workspace.id,workspace.base_commit,build.id,sourceHash(files),proposal.id);
    res.status(202).json({proposal:proposalShape(one('SELECT * FROM github_proposals WHERE id=?',proposal.id)!),build:buildShape(build)});
  }));
  app.post('/api/projects/:id/repository/proposals/:proposalId/approve',authenticated,route(async(req,res)=>{
    const p=getProject(String(req.params.id),res,true);ownProject(p);const proposal=one('SELECT * FROM github_proposals WHERE id=? AND project_id=?',String(req.params.proposalId),p.id);if(!proposal)throw new HttpError(404,'Không có đề xuất này.');if(proposal.status!=='pending')throw new HttpError(409,'Đề xuất đã được xử lý; không tự lặp lại thao tác GitHub.');
    const {link,connection}=linkAndConnection(p.id,res);
    if(!githubStatus(options.github).connected)throw new HttpError(503,'GitHub App chưa cấu hình; chưa tạo nhánh hoặc Pull Request.');
    if(p.locked)throw new HttpError(409,'Mở khóa dự án trước khi phê duyệt thay đổi mã nguồn.');
    verifyProposalValidation(proposal,link);
    const token=await github.token(connection),remoteBase=await github.request(`/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}/git/ref/heads/${encodeURIComponent(proposal.base)}`,token);
    if(remoteBase?.object?.sha!==proposal.source_base_commit)throw new HttpError(409,'Nhánh gốc đã thay đổi sau snapshot; cần snapshot và kiểm thử mới.','BASE_CHANGED');
    let claimedForWrite=false;
    const checkAuthorization=()=>{const actor=currentActor(p.id,uid(res),true);if(actor.locked)throw new HttpError(409,'Dự án vừa bị khóa.');const fresh=currentLink(p.id);if(fresh.connection_id!==link.connection_id||fresh.owner!==link.owner||fresh.repository!==link.repository||fresh.branch!==link.branch)throw new HttpError(409,'Liên kết repository đã thay đổi.');const saved=one('SELECT * FROM github_proposals WHERE id=?',proposal.id);if(!saved||saved.status!==(claimedForWrite?'running':'pending')||saved.validation_build_id!==proposal.validation_build_id||saved.validation_hash!==proposal.validation_hash||saved.workspace_id!==proposal.workspace_id)throw new HttpError(409,'Kết quả kiểm thử đã thay đổi.');verifyProposalValidation(saved,fresh);};
    checkAuthorization();
    const claimed=run("UPDATE github_proposals SET status='running',approved_by=?,approved_at=? WHERE id=? AND status='pending' AND validation_build_id=? AND validation_hash=?",uid(res),now(),proposal.id,proposal.validation_build_id,proposal.validation_hash);
    if(!claimed.changes)throw new HttpError(409,'Đề xuất đã được xử lý.');
    claimedForWrite=true;
    try{const pull=await github.applyProposal(connection,link,proposal,checkAuthorization);run("UPDATE github_proposals SET status='succeeded',pull_url=? WHERE id=?",pull.html_url,proposal.id);audit(uid(res),p.id,'github.pull_request_created',pull.html_url);res.json({proposal:proposalShape(one('SELECT * FROM github_proposals WHERE id=?',proposal.id)!),pull});}
    catch(error){if(!closed)run("UPDATE github_proposals SET status='failed',error=? WHERE id=?",'Thao tác GitHub thất bại hoặc chưa xác định; kiểm tra repository trước khi đề xuất lại.',proposal.id);throw error;}
  }));
  app.post('/api/github/webhook',route((req,res)=>{
    if(!github.config.webhookSecret)throw new HttpError(503,'Webhook chưa được cấu hình.');
    const raw=(req as any).rawBody as Buffer|undefined;if(!raw||!verifyWebhook(raw,req.headers['x-hub-signature-256'],github.config.webhookSecret))throw new HttpError(401,'Chữ ký webhook không hợp lệ.');
    const delivery=z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/).parse(req.headers['x-github-delivery']),event=z.string().min(1).max(80).parse(req.headers['x-github-event']);
    if(one('SELECT 1 FROM github_webhooks WHERE delivery_id=?',delivery)){res.json({ok:true,duplicate:true});return;}
    transaction(()=>{run('INSERT INTO github_webhooks(delivery_id,event,installation_id,received_at,payload_hash) VALUES(?,?,?,?,?)',delivery,event,String(req.body.installation?.id||''),now(),createHash('sha256').update(raw).digest('hex'));const full=req.body.repository?.full_name;if(typeof full==='string')for(const link of all("SELECT * FROM repository_links WHERE owner||'/'||repository=?",full))run('INSERT INTO activity(id,project_id,actor_id,action,detail,created_at) SELECT ?,id,owner_id,?,?,? FROM projects WHERE id=?',randomUUID(),'github.webhook',event,now(),link.project_id);});res.json({ok:true,duplicate:false});
  }));

  async function queueBuild(projectId:string,actorId:string,files:Record<string,string>,label:string,extra:{workspaceId?:string;toolActionId?:string;ownerOnly?:boolean}={}) {
    const actor=currentActor(projectId,actorId,!!extra.ownerOnly);
    if(!projectPermissions(actor.role,!!actor.locked).runBuild)throw new HttpError(403,'Không có quyền chạy build.');
    validateSourceFiles(files);version.parse(label);
    if(!enabled||!await runnerReady)throw new HttpError(503,'Runner Docker chưa được cấu hình/không truy cập được.');
    const hash=sourceHash(files);
    let result:Row|undefined;
    transaction(()=>{
      const freshActor=currentActor(projectId,actorId,!!extra.ownerOnly);if(!projectPermissions(freshActor.role,!!freshActor.locked).runBuild)throw new HttpError(403,'Không còn quyền chạy build.');
      if(extra.toolActionId){const existing=one('SELECT * FROM build_jobs WHERE tool_action_id=?',extra.toolActionId);if(existing){if(existing.project_id!==projectId||existing.author_id!==actorId||existing.source_hash!==hash||existing.version!==label)throw new HttpError(409,'Mã thao tác đã được dùng cho build khác.');result=existing;return;}}
      if((one("SELECT COUNT(*) AS n FROM build_jobs WHERE project_id=? AND status IN ('queued','preparing','building','testing')",projectId)?.n||0)>=3)throw new HttpError(429,'Dự án đã có 3 build đang chờ/chạy.');
      const stored=Number(one('SELECT COALESCE(SUM(artifact_size),0) AS n FROM build_jobs WHERE project_id=?',projectId)?.n||0);
      if(stored>50*1024*1024)throw new HttpError(413,'Kho artifact dự án vượt hạn mức 50 MiB.');
      const sources=Number(one('SELECT COALESCE(SUM(length(CAST(files_json AS BLOB))),0) AS n FROM build_jobs WHERE project_id=?',projectId)?.n||0);
      if(sources+Buffer.byteLength(JSON.stringify(files))>10*1024*1024)throw new HttpError(413,'Lịch sử mã nguồn build dự án vượt hạn mức 10 MiB.');
      const id=randomUUID();run('INSERT INTO build_jobs(id,project_id,author_id,target,version,status,files_json,created_at,tool_action_id,workspace_id,source_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,projectId,actorId,'web',label,'queued',JSON.stringify(files),now(),extra.toolActionId||null,extra.workspaceId||null,hash);
      audit(actorId,projectId,'build.queued',id);result=getBuild(projectId,id);
    });
    if(options.autoRun!==false&&running.size===0&&result!.status==='queued')queueMicrotask(()=>void executeBuild(result!.id));
    return result!;
  }
  const actionSchema=z.object({id:z.string().uuid(),projectId:z.string().uuid(),type:z.enum(['request_build','propose_source_change']),arguments:z.object({files:z.record(z.string(),z.string()),version:version.optional(),branch:branch.optional(),base:branch.optional(),title:z.string().trim().min(2).max(200).optional(),body:z.string().max(10000).optional(),workspaceId:z.string().uuid().optional()})});
  async function enqueueApprovedBuild(input:ApprovedIntegrationAction,actorId:string):Promise<Record<string,unknown>> {
    const action=actionSchema.parse(input);if(action.type!=='request_build')throw new HttpError(400,'Loại thao tác không phải build.');
    const build=await queueBuild(action.projectId,actorId,action.arguments.files,action.arguments.version||'ai-'+action.id.slice(0,8),{toolActionId:action.id,ownerOnly:true});
    return {build:buildShape(build)};
  }
  async function enqueueSourceProposal(input:ApprovedIntegrationAction,actorId:string):Promise<Record<string,unknown>> {
    const action=actionSchema.parse(input);if(action.type!=='propose_source_change')throw new HttpError(400,'Loại thao tác không phải đề xuất mã nguồn.');
    const d=action.arguments;
    const proposal=saveProposal(action.projectId,actorId,{branch:d.branch,base:d.base,title:d.title,body:d.body||'',workspaceId:d.workspaceId,files:Object.entries(d.files).map(([path,content])=>({path,content}))},{id:action.id,hash:createHash('sha256').update(JSON.stringify(action)).digest('hex')});
    return {proposal:proposalShape(proposal)};
  }

  async function executeBuild(id:string) {
    if(closed||running.size>0)return;const job=one("SELECT * FROM build_jobs WHERE id=? AND status='queued'",id);if(!job)return;
    const controller=new AbortController();running.set(id,controller);run("UPDATE build_jobs SET status='preparing',started_at=? WHERE id=?",now(),id);
    try {
      run("UPDATE build_jobs SET status='testing' WHERE id=?",id);
      const completed=await(options.runBuild||runWebBuild)({files:JSON.parse(job.files_json),workDir:join(ctx.dataDir,'runner-work',id),signal:controller.signal});
      const result:BuildResult=controller.signal.aborted?{status:'cancelled',exitCode:completed.exitCode,logs:completed.logs+'\nBuild bị hủy.'}:completed;
      let artifactPath:string|null=null;
      if(result.status==='succeeded'&&result.artifact){const directory=join(ctx.dataDir,'artifacts');await mkdir(directory,{recursive:true,mode:0o700});artifactPath=join(directory,id+'.zip');await writeFile(artifactPath,result.artifact,{flag:'wx',mode:0o600});}
      if(!closed)transaction(()=>{run('UPDATE build_jobs SET status=?,logs=?,exit_code=?,artifact_path=?,artifact_hash=?,artifact_size=?,finished_at=? WHERE id=?',result.status,result.logs,result.exitCode,artifactPath,result.sha256||null,result.artifact?.length||null,now(),id);audit(job.author_id,job.project_id,'build.'+result.status,id);notify(job.author_id,'build',`${job.version}: ${result.status}`,`/projects/${job.project_id}`);});
    } catch {if(!closed)run("UPDATE build_jobs SET status='failed',logs=?,finished_at=? WHERE id=?",'Runner gặp lỗi. Không tạo artifact thành công.',now(),id);}
    finally{running.delete(id);if(!closed){const next=one("SELECT id FROM build_jobs WHERE status='queued' ORDER BY created_at LIMIT 1");if(next)queueMicrotask(()=>void executeBuild(next.id));}}
  }
  app.get('/api/projects/:id/builds',authenticated,route((req,res)=>{const p=memberProject(String(req.params.id),res);res.json({builds:all('SELECT * FROM build_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 100',p.id).map(buildShape),releases:all('SELECT * FROM build_releases WHERE project_id=? ORDER BY created_at DESC',p.id).map(releaseShape)});}));
  app.post('/api/projects/:id/builds',authenticated,route(async(req,res)=>{
    const d=z.object({target:z.literal('web'),version,files:z.record(z.string(),z.string())}).parse(req.body);
    const build=await queueBuild(String(req.params.id),uid(res),d.files,d.version);
    res.status(202).json({build:buildShape(build)});
  }));
  app.get('/api/projects/:id/builds/:buildId',authenticated,route((req,res)=>{memberProject(String(req.params.id),res);res.json({build:buildShape(getBuild(String(req.params.id),String(req.params.buildId)))});}));
  app.post('/api/projects/:id/builds/:buildId/cancel',authenticated,route((req,res)=>{const p=getProject(String(req.params.id),res);if(!projectPermissions(p.role,!!p.locked).runBuild)throw new HttpError(403,'Không có quyền hủy build trong trạng thái hiện tại.');const b=getBuild(p.id,String(req.params.buildId));if(!['owner','manager'].includes(p.role)&&b.author_id!==uid(res))throw new HttpError(403,'Không có quyền hủy build.');if(['succeeded','failed','cancelled'].includes(b.status))throw new HttpError(409,'Build đã kết thúc.');const active=running.get(b.id);if(active)active.abort();else run("UPDATE build_jobs SET status='cancelled',finished_at=? WHERE id=?",now(),b.id);res.json({build:buildShape(getBuild(p.id,b.id))});}));
  app.get('/api/projects/:id/builds/:buildId/artifact',route((req,res)=>{
    const p=getProject(String(req.params.id),res),b=getBuild(p.id,String(req.params.buildId));
    if(!projectPermissions(p.role,!!p.locked).downloadArtifact&&!one('SELECT 1 FROM build_releases WHERE build_id=? AND published=1',b.id))throw new HttpError(403,'Vai trò này không có quyền tải mã nguồn; artifact chưa được chủ dự án công khai.');
    if(b.status!=='succeeded'||!b.artifact_path)throw new HttpError(404,'Build chưa có artifact thành công.');
    const root=resolve(ctx.dataDir,'artifacts'),path=resolve(b.artifact_path),rel=relative(root,path);if(rel.startsWith('..')||!existsSync(path))throw new HttpError(404,'Artifact không còn khả dụng.');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.setHeader('X-Content-Type-Options','nosniff');res.download(path,`pixel-world-${b.version}.zip`);
  }));
  app.post('/api/projects/:id/releases',authenticated,route((req,res)=>{const p=getProject(String(req.params.id),res,true);ownProject(p);const d=z.object({buildId:z.string().uuid(),version,changelog:z.string().trim().min(1).max(10000),published:z.boolean()}).parse(req.body),b=getBuild(p.id,d.buildId);if(b.status!=='succeeded')throw new HttpError(409,'Chỉ phát hành build thành công.');if(d.published&&p.visibility!=='public')throw new HttpError(409,'Cần chủ dự án đặt dự án công khai trước khi phát hành công khai.');if(one('SELECT 1 FROM build_releases WHERE project_id=? AND version=?',p.id,d.version))throw new HttpError(409,'Version đã được phát hành.');const id=randomUUID();run('INSERT INTO build_releases(id,project_id,build_id,version,changelog,published,approved_by,created_at) VALUES(?,?,?,?,?,?,?,?)',id,p.id,b.id,d.version,d.changelog,d.published?1:0,uid(res),now());audit(uid(res),p.id,'build.released',d.version);res.status(201).json({release:releaseShape(one('SELECT * FROM build_releases WHERE id=?',id)!)});}));
  return {enqueueApprovedBuild,enqueueSourceProposal,close(){closed=true;for(const controller of running.values())controller.abort();}};
}
