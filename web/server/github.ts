import { createCipheriv, createDecipheriv, createHmac, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import type { ModuleContext, Row } from './context.js';
import { HttpError } from './context.js';

export interface GitHubConfig {
  appId?: string; privateKey?: string; webhookSecret?: string; encryptionKey?: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}
export function githubConfig(options:GitHubConfig={}):GitHubConfig {
  return {appId:options.appId??process.env.GH_APP_ID,privateKey:options.privateKey??process.env.GH_APP_PRIVATE_KEY,webhookSecret:options.webhookSecret??process.env.GH_WEBHOOK_SECRET,encryptionKey:options.encryptionKey??process.env.APP_ENCRYPTION_KEY,fetcher:options.fetcher??fetch};
}
export function githubStatus(options:GitHubConfig={}) {
  const c=githubConfig(options),configured=!!(c.appId&&c.privateKey&&c.encryptionKey);
  return {connected:configured,status:configured?'configured':'not_configured',message:configured?'Đã có cấu hình GitHub App; quyền truy cập từng installation được kiểm tra khi gọi GitHub.':'Cần GitHub App, private key và khóa mã hóa token ở máy chủ. Chưa xác minh truy cập GitHub thật.',webhookConfigured:!!c.webhookSecret};
}
function encryptionKey(value?:string) {if(!value)throw new HttpError(503,'Chưa cấu hình khóa mã hóa GitHub.');const key=/^[a-fA-F0-9]{64}$/.test(value)?Buffer.from(value,'hex'):Buffer.from(value,'base64');if(key.length!==32)throw new HttpError(503,'APP_ENCRYPTION_KEY phải là khóa 32 byte hex hoặc base64.');return key;}
export function encryptToken(token:string,key:string) {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(key),iv),body=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(b=>b.toString('base64url')).join('.');}
export function decryptToken(value:string,key:string) {const [iv,tag,body]=value.split('.').map(v=>Buffer.from(v,'base64url'));if(!iv||!tag||!body)throw new Error('Invalid encrypted token');const c=createDecipheriv('aes-256-gcm',encryptionKey(key),iv);c.setAuthTag(tag);return Buffer.concat([c.update(body),c.final()]).toString('utf8');}
export function verifyWebhook(body:Buffer,signature:unknown,secret?:string) {
  if(!secret||typeof signature!=='string'||!/^sha256=[0-9a-f]{64}$/i.test(signature))return false;
  const expected=Buffer.from('sha256='+createHmac('sha256',secret).update(body).digest('hex'));
  const actual=Buffer.from(signature);return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
const encoded=(value:string)=>encodeURIComponent(value);
export function safeBranch(value:string) {return typeof value==='string'&&value.length<=100&&/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value)&&!value.includes('..')&&!value.endsWith('/')&&!value.endsWith('.lock')&&!value.includes('//');}
export function safeRepositoryPath(value:string) {return typeof value==='string'&&value.length<=200&&/^[A-Za-z0-9_./-]+$/.test(value)&&value.split('/').every(p=>p!==''&&p!=='.'&&p!=='..')&&!value.startsWith('.git/')&&!value.startsWith('.github/workflows/');}

export class GitHubClient {
  readonly config:GitHubConfig;
  constructor(private ctx:ModuleContext, options:GitHubConfig={}) {this.config=githubConfig(options);}
  private jwt() {
    const c=this.config;
    if(!c.appId||!c.privateKey||!c.encryptionKey)throw new HttpError(503,'GitHub App chưa được cấu hình.');
    encryptionKey(c.encryptionKey);
    const timestamp=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iat:timestamp-60,exp:timestamp+540,iss:c.appId})).toString('base64url');
    try {return `${header}.${payload}.${sign('RSA-SHA256',Buffer.from(`${header}.${payload}`),c.privateKey.replace(/\\n/g,'\n')).toString('base64url')}`;}catch{throw new HttpError(503,'Private key GitHub App không hợp lệ.');}
  }
  async request(path:string,token:string,method='GET',body?:unknown) {
    if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Unsafe GitHub request path');
    const response=await this.config.fetcher!('https://api.github.com'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Pixel-AI-World',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok){if([401,403,404].includes(response.status))throw new HttpError(response.status===404?404:403,'GitHub từ chối truy cập tài nguyên này.');if(response.status===429||response.status===422)throw new HttpError(response.status,'GitHub từ chối thao tác hoặc giới hạn lượt gọi.');throw new HttpError(502,'Dịch vụ GitHub trả về lỗi.');}
    if(response.status===204)return null;
    const length=Number(response.headers.get('content-length')||0);if(length>2*1024*1024)throw new HttpError(413,'Phản hồi GitHub quá lớn.');
    const reader=response.body?.getReader();if(!reader)return null;let size=0;const chunks:Uint8Array[]=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw new HttpError(413,'Phản hồi GitHub quá lớn.');}chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async inspectInstallation(installationId:string) {return this.request('/app/installations/'+encoded(installationId),this.jwt());}
  async token(connection:Row) {
    if(!this.config.appId||!this.config.privateKey||!this.config.encryptionKey)throw new HttpError(503,'GitHub App chưa được cấu hình đầy đủ.');
    if(connection.encrypted_token&&Date.parse(connection.token_expires_at)>Date.now()+60000){try{return decryptToken(connection.encrypted_token,this.config.encryptionKey!)}catch{throw new HttpError(503,'Không giải mã được token GitHub đã lưu.');}}
    const result=await this.request('/app/installations/'+encoded(connection.installation_id)+'/access_tokens',this.jwt(),'POST',{});
    if(typeof result?.token!=='string'||!Number.isFinite(Date.parse(result?.expires_at)))throw new HttpError(502,'GitHub trả token không hợp lệ.');
    this.ctx.run('UPDATE github_connections SET encrypted_token=?,token_expires_at=? WHERE id=?',encryptToken(result.token,this.config.encryptionKey!),result.expires_at,connection.id);
    return result.token as string;
  }
  async repository(connection:Row,owner:string,repository:string) {
    const token=await this.token(connection);
    const result=await this.request(`/repos/${encoded(owner)}/${encoded(repository)}`,token);
    return {data:result,token};
  }
  async applyProposal(connection:Row,link:Row,proposal:Row,guard:()=>void) {
    if(!safeBranch(proposal.branch)||!safeBranch(proposal.base)||['main','master'].includes(proposal.branch)||proposal.branch===proposal.base)throw new HttpError(400,'Nhánh thay đổi phải là nhánh riêng, khác nhánh gốc.');
    const {token,data}=await this.repository(connection,link.owner,link.repository);
    if(proposal.branch===data.default_branch)throw new HttpError(400,'Không được ghi trực tiếp vào nhánh mặc định.');
    if(!data.permissions?.push)throw new HttpError(403,'Installation không có quyền ghi repository.');
    const prefix=`/repos/${encoded(link.owner)}/${encoded(link.repository)}`;
    const base=await this.request(prefix+'/git/ref/heads/'+encoded(proposal.base),token);
    if(base?.object?.sha!==proposal.source_base_commit)throw new HttpError(409,'Nhánh gốc đã thay đổi sau kiểm thử.','BASE_CHANGED');
    const commit=await this.request(prefix+'/git/commits/'+encoded(base.object.sha),token);
    guard();
    const files=JSON.parse(proposal.files_json) as Array<{path:string;content:string}>;
    guard();
    const tree=await this.request(prefix+'/git/trees',token,'POST',{base_tree:commit.tree.sha,tree:files.map(file=>({path:file.path,mode:'100644',type:'blob',content:file.content}))});
    guard();
    const created=await this.request(prefix+'/git/commits',token,'POST',{message:proposal.title,tree:tree.sha,parents:[base.object.sha]});
    // Creating a new ref fails if the branch exists; never update/force a ref.
    const unchanged=await this.request(prefix+'/git/ref/heads/'+encoded(proposal.base),token);
    if(unchanged?.object?.sha!==proposal.source_base_commit)throw new HttpError(409,'Nhánh gốc thay đổi trong lúc tạo đề xuất; cần kiểm tra lại.','BASE_CHANGED');
    guard();
    await this.request(prefix+'/git/refs',token,'POST',{ref:'refs/heads/'+proposal.branch,sha:created.sha});
    guard();
    return this.request(prefix+'/pulls',token,'POST',{title:proposal.title,body:proposal.body,head:proposal.branch,base:proposal.base});
  }
}
