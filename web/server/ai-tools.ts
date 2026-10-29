import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModuleContext, Row } from './context.js';
import { HttpError } from './context.js';
import { ProviderError, type ProviderTool, type ProviderToolCall, type ProviderMessage } from './ai-providers.js';

export const AI_ROLES = ['planner','game_designer','ui_designer','developer','tester','reviewer','build_engineer','coordinator'] as const;
export const MAX_TOOL_TURNS = 3;
export const MAX_TOOL_RESULT_BYTES = 8192;
export const MAX_ASSISTANT_BYTES = 16384;
export interface ApprovedAIAction {
  id: string;
  jobId: string;
  projectId: string;
  type: 'request_build' | 'propose_source_change';
  arguments: { files: Record<string,string>; version?: string; branch?: string; base?: string; title?: string; body?: string; workspaceId?: string };
}
export interface ToolRuntimeOptions {
  clock?: () => number;
  executeApprovedAction?: (action: ApprovedAIAction, actorId: string) => Promise<Record<string,unknown>>;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const branch = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/).refine(v=>!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.lock'));
const pathAllowed = (path: string) => path.length <= 150 && /^[a-zA-Z0-9_./-]+\.(?:html|css|js|mjs|cjs|json|md|txt)$/.test(path) && path.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&!p.startsWith('.'));
const files = z.record(z.string(), z.string()).refine(value => {
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 20 && entries.every(([path])=>pathAllowed(path)) && Buffer.byteLength(JSON.stringify(value)) <= 12000;
}, 'Chỉ nhận tối đa 20 tệp văn bản an toàn, tổng JSON không quá 12 KiB.');
const sourceArguments = z.object({title:z.string().trim().min(2).max(100),body:z.string().max(1000).optional(),branch,base:branch,files,workspaceId:z.string().uuid().optional()}).strict().refine(v=>!['main','master',v.base].includes(v.branch),'Đề xuất phải dùng nhánh riêng.');
const buildArguments = z.object({version:z.string().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),files}).strict().refine(v=>typeof v.files['index.html']==='string','Build cần index.html.');
const noArguments = z.object({}).strict();
const fileSchema = {type:'object',additionalProperties:{type:'string'},description:'Map of safe relative text file paths to complete contents; maximum 20 files and 12 KiB JSON.'};
export const AI_TOOLS: ProviderTool[] = [
  {name:'read_project',description:'Read the current authorized project summary. Never reads host files or secrets.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'read_tasks',description:'Read at most twenty tasks in the current authorized project.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'propose_source_change',description:'Save an immutable source-change proposal for the project owner to review. Does not write GitHub or execute code.',inputSchema:{type:'object',properties:{title:{type:'string'},body:{type:'string'},branch:{type:'string'},base:{type:'string'},workspaceId:{type:'string'},files:fileSchema},required:['title','branch','base','files'],additionalProperties:false}},
  {name:'request_build',description:'Propose an isolated static-web build. Nothing executes until the project owner approves.',inputSchema:{type:'object',properties:{version:{type:'string'},files:fileSchema},required:['version','files'],additionalProperties:false}},
];

function safeLogValue(value: unknown, depth=0): unknown {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return value.slice(0,16384).replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g,'[redacted credential]');
  if (Array.isArray(value)) return value.slice(0,30).map(v=>safeLogValue(v,depth+1));
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>!['__proto__','prototype','constructor'].includes(key)).slice(0,40).map(([key,v])=>[key,/(?:password|secret|api.?key|authorization|private.?key|access.?token)/i.test(key)?'[redacted]':safeLogValue(v,depth+1)]));
  return value;
}
const safeLog = (value: unknown) => JSON.stringify(safeLogValue(value));
function toolResult(result: unknown) {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text)>MAX_TOOL_RESULT_BYTES) return JSON.stringify({error:'TOOL_RESULT_LIMIT',message:'Dữ liệu vượt giới hạn; nội dung không được gửi tới provider.'});
  return text;
}

export function createToolRuntime(ctx: ModuleContext, options: ToolRuntimeOptions = {}) {
  const {one,all,run,transaction,app,authenticated,route,uid,getProject,audit} = ctx;
  const iso = () => new Date((options.clock||Date.now)()).toISOString();
  const proposalShape = (row: Row) => ({id:row.id,jobId:row.job_id,projectId:row.project_id,type:row.type,arguments:JSON.parse(row.arguments_json),status:row.status,version:row.version,result:row.result_json?JSON.parse(row.result_json):null,error:row.error,createdAt:row.created_at,reviewedAt:row.reviewed_at});
  function checkActor(job: Row) {
    const project=one('SELECT p.*,m.role FROM projects p JOIN project_members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=? AND p.deleted_at IS NULL',job.user_id,job.project_id);
    if(!project||!['owner','manager','developer'].includes(project.role)||(project.locked&&project.role!=='owner')) throw new ProviderError('TOOL_ACCESS_REVOKED','Quyền dùng công cụ dự án đã bị thu hồi.');
    return project;
  }
  // An external operation may have completed before a crash. Never blindly retry it.
  run("UPDATE ai_tool_proposals SET status='uncertain',error=?,version=version+1 WHERE status='running'",'Server đã dừng giữa thao tác duyệt; cần kiểm tra kết quả theo proposal ID trước khi xử lý tiếp.');

  function pending(jobId: string) {return !!one("SELECT 1 FROM ai_tool_proposals WHERE job_id=? AND status IN ('pending','running','uncertain')",jobId);}
  function refreshJob(jobId:string) {
    const job=one('SELECT * FROM ai_jobs WHERE id=?',jobId);
    if(!job||!['waiting_approval','completed'].includes(job.status))return;
    const planPending=!!job.plan_json&&!one('SELECT 1 FROM ai_plan_tasks WHERE job_id=?',jobId);
    run('UPDATE ai_jobs SET status=?,version=version+1,updated_at=? WHERE id=?',pending(jobId)||planPending?'waiting_approval':'completed',iso(),jobId);
  }
  function execute(job: Row, call: ProviderToolCall): ProviderMessage {
    checkActor(job);
    if(!job.tools_enabled)throw new ProviderError('TOOLS_NOT_ENABLED','Tác vụ chưa được cấp quyền công cụ.');
    if(!AI_TOOLS.some(tool=>tool.name===call.name))throw new ProviderError('UNKNOWN_TOOL','AI yêu cầu công cụ không được cấp phép.');
    if(Buffer.byteLength(JSON.stringify(call.arguments))>16384)throw new ProviderError('TOOL_ARGUMENT_LIMIT','Tham số công cụ vượt giới hạn.');
    if(one('SELECT 1 FROM ai_tool_calls WHERE job_id=? AND call_id=?',job.id,call.id))throw new ProviderError('DUPLICATE_TOOL_CALL','Provider gửi lại tool call đã được xử lý.');
    const callId=randomUUID();
    let result: unknown;
    let error: string|null=null;
    transaction(()=>{
      run('INSERT INTO ai_tool_calls(id,job_id,call_id,name,arguments_json,status,created_at) VALUES(?,?,?,?,?,?,?)',callId,job.id,call.id,call.name,safeLog(call.arguments),'completed',iso());
      try {
        if(call.name==='read_project') {
          noArguments.parse(call.arguments);const project=checkActor(job);
          result={id:project.id,name:project.name,description:project.description.slice(0,1500),status:project.status,visibility:project.visibility,locked:!!project.locked};
        } else if(call.name==='read_tasks') {
          noArguments.parse(call.arguments);
          result={tasks:all('SELECT id,title,description,status,type,priority FROM tasks WHERE project_id=? ORDER BY created_at,id LIMIT 20',job.project_id).map(t=>({...t,description:t.description.slice(0,500)})),total:one('SELECT COUNT(*) AS n FROM tasks WHERE project_id=?',job.project_id)!.n};
        } else {
          const args=call.name==='request_build'?buildArguments.parse(call.arguments):sourceArguments.parse(call.arguments);
          const proposalId=randomUUID();const serialized=JSON.stringify(args);
          run('INSERT INTO ai_tool_proposals(id,job_id,project_id,call_id,type,arguments_json,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',proposalId,job.id,job.project_id,callId,call.name,serialized,hash(serialized),iso());
          result={proposalId,status:'pending',requiresOwnerApproval:true,executed:false};
          audit(job.user_id,job.project_id,'ai.tool_proposed',proposalId);
        }
      } catch (caught) {
        error=caught instanceof ProviderError?caught.code:'INVALID_TOOL_ARGUMENTS';
        result={error,message:'Công cụ không được thực hiện; kiểm tra schema và quyền đã cấp.'};
      }
      const content=toolResult(result);
      run('UPDATE ai_tool_calls SET result_json=?,status=?,error=? WHERE id=?',content,error?'failed':'completed',error,callId);
      audit(job.user_id,job.project_id,error?'ai.tool_failed':'ai.tool_executed',`${call.name}:${call.id}`);
    });
    return {role:'tool',toolCallId:call.id,content:toolResult(result)};
  }
  function details(jobId: string) {
    return {toolCalls:all('SELECT * FROM ai_tool_calls WHERE job_id=? ORDER BY created_at,id',jobId).map(row=>({id:row.id,callId:row.call_id,name:row.name,arguments:JSON.parse(row.arguments_json),result:row.result_json?JSON.parse(row.result_json):null,status:row.status,error:row.error,createdAt:row.created_at})),toolProposals:all('SELECT * FROM ai_tool_proposals WHERE job_id=? ORDER BY created_at,id',jobId).map(proposalShape)};
  }
  function review(id:string,res:any,version:number) {
    const proposal=one('SELECT * FROM ai_tool_proposals WHERE id=?',id);
    if(!proposal)throw new HttpError(404,'Đề xuất không tồn tại.');
    const project=getProject(proposal.project_id,res);
    if(project.role!=='owner')throw new HttpError(403,'Chỉ chủ dự án được duyệt công cụ nhạy cảm.');
    if(project.locked)throw new HttpError(403,'Hãy mở khóa dự án trước khi duyệt công cụ.');
    const job=one('SELECT * FROM ai_jobs WHERE id=?',proposal.job_id)!;
    try {checkActor(job);} catch {throw new HttpError(403,'Quyền dùng công cụ của người gửi đã bị thu hồi.');}
    if(!['waiting_approval','completed'].includes(job.status))throw new HttpError(409,'Tác vụ chưa hoàn tất hoặc đã bị hủy/thất bại.');
    if(proposal.status!=='pending'||proposal.version!==version)throw new HttpError(409,'Đề xuất đã thay đổi hoặc đã được xử lý.','VERSION_CONFLICT');
    if(hash(proposal.arguments_json)!==proposal.payload_hash)throw new HttpError(409,'Nội dung đề xuất không còn nguyên vẹn.');
    return proposal;
  }
  app.post('/api/ai/tool-proposals/:id/approve',authenticated,route(async(req,res)=>{
    const {version}=z.object({version:z.number().int().positive()}).strict().parse(req.body);
    const p=review(String(req.params.id),res,version);
    if(!options.executeApprovedAction)throw new HttpError(503,'Chưa cấu hình cầu nối thực thi công cụ.');
    const args=p.type==='request_build'?buildArguments.parse(JSON.parse(p.arguments_json)):sourceArguments.parse(JSON.parse(p.arguments_json));
    run("UPDATE ai_tool_proposals SET status='running',version=version+1,reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending' AND version=?",uid(res),iso(),p.id,version);
    audit(uid(res),p.project_id,'ai.tool_approved',p.id);
    try {
      const result=await options.executeApprovedAction({id:p.id,jobId:p.job_id,projectId:p.project_id,type:p.type,arguments:args},uid(res));
      if(!one("SELECT 1 FROM ai_tool_proposals WHERE id=? AND status='running'",p.id))throw new HttpError(409,'Trạng thái đề xuất đã thay đổi.');
      run("UPDATE ai_tool_proposals SET status='approved',result_json=?,version=version+1 WHERE id=?",safeLog(result),p.id);
      refreshJob(p.job_id);
      res.json({proposal:proposalShape(one('SELECT * FROM ai_tool_proposals WHERE id=?',p.id)!)});
    } catch {
      run("UPDATE ai_tool_proposals SET status='uncertain',error=?,version=version+1 WHERE id=?",'Chưa xác nhận được kết quả. Không tự chạy lại; kiểm tra bằng proposal ID.',p.id);
      refreshJob(p.job_id);
      throw new HttpError(502,'Kết quả thực thi chưa được xác nhận. Cần kiểm tra trước khi thử thao tác khác.','TOOL_ACTION_UNCERTAIN');
    }
  }));
  app.post('/api/ai/tool-proposals/:id/reject',authenticated,route((req,res)=>{
    const d=z.object({version:z.number().int().positive(),reason:z.string().trim().min(1).max(1000)}).strict().parse(req.body);
    const p=review(String(req.params.id),res,d.version);
    run("UPDATE ai_tool_proposals SET status='rejected',error=?,version=version+1,reviewed_by=?,reviewed_at=? WHERE id=?",d.reason,uid(res),iso(),p.id);
    audit(uid(res),p.project_id,'ai.tool_rejected',p.id);refreshJob(p.job_id);
    res.json({proposal:proposalShape(one('SELECT * FROM ai_tool_proposals WHERE id=?',p.id)!)});
  }));
  return {execute,details,pending,refreshJob};
}
