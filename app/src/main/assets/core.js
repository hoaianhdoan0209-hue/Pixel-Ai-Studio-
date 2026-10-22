(function(root){
'use strict';
const ROLES=[['Atlas','Leader','#ebbe65'],['Vera','Kiểm duyệt','#e4a2a2'],['Milo','Thiết kế','#9acbb0'],['Kai','Gameplay','#8ebcdd'],['Nova','Hệ thống','#b7a9d8'],['Lumi','Mỹ thuật','#e8b485'],['Echo','Nội dung / âm thanh','#b9c878']];
function uid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const b=new Uint8Array(1);if(root.crypto?.getRandomValues)root.crypto.getRandomValues(b);else b[0]=Math.random()*256;return (c==='x'?b[0]&15:(b[0]&3)|8).toString(16);});}
function normalize(endpoint,model){endpoint=endpoint.trim().replace(/\/+$/,'').replace(/\/chat\/completions$/,'');if(/^https:\/\/generativelanguage.googleapis.com(?:\/v1beta)?$/.test(endpoint))endpoint+=''+(endpoint.endsWith('v1beta')?'/openai':'/v1beta/openai');const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password)throw Error('API cần URL HTTPS.');model=model.trim();if(u.hostname==='generativelanguage.googleapis.com')model=model.replace(/^models\//,'');if(!model)throw Error('Chưa nhập tên model.');return {endpoint,model};}
function graph(){return [
 ['plan',0,[],'Lập kế hoạch, chia file và khóa giao diện tích hợp.'],
 ['design',2,['plan'],'Thiết kế nội dung, cơ chế và số liệu cần triển khai.'],
 ['art',5,['plan'],'Thiết kế tài nguyên theo kế hoạch; chỉ xuất định dạng nền tảng thực sự hỗ trợ.'],
 ['audio',6,['plan'],'Làm nội dung, hội thoại và đặc tả âm thanh; dùng âm có sẵn khi phù hợp.'],
 ['foundation',4,['plan'],'Tạo khung hệ thống và cấu trúc file thống nhất.'],
 ['gameplay',3,['design'],'Triển khai toàn bộ logic gameplay theo thiết kế.'],
 ['design-review',1,['design'],'Kiểm tra sớm tính khả thi và lỗi thiết kế.'],
 ['integrate',4,['foundation','gameplay','art','audio','design-review'],'Tích hợp thành bộ file hoàn chỉnh, tự chứa. Trả lại toàn bộ các file cần thiết, không chỉ diff.'],
 ['final-review',1,['integrate'],'Đọc bản tích hợp, kiểm tra tĩnh và nêu lỗi. Không khẳng định đã chạy game.']
].map(([id,role,deps,task])=>({id,role,deps,task,status:'queued',due:0,attempt:0,text:'',error:''}));}
function makeJob(name,brief,kind,config){if(!brief.trim())throw Error('Nhập nhiệm vụ trước.');return {id:uid(),name:name.trim()||'Studio Project',brief:brief.trim(),kind,config,nodes:graph(),uuids:[uid(),uid(),uid(),uid()],cancelled:false};}
function ancestors(job,node){const seen=new Set();function add(n){for(const id of n.deps){if(!seen.has(id)){seen.add(id);add(job.nodes.find(t=>t.id===id));}}}add(node);return job.nodes.filter(n=>seen.has(n.id));}
function filesFrom(text){const files={};for(const m of text.matchAll(/```file:([^\n]+)\n([\s\S]*?)```/g)){let p=m[1].trim().replace(/\\/g,'/');if(p.startsWith('/')||p.includes(':')||p.split('/').some(x=>x==='..'||x==='.')||!p)continue;if(/\.(?:json|js|html|css|txt|md|lang|mcfunction)$/i.test(p))files[p]=m[2];}return files;}
function platform(job){if(job.kind!=='bedrock')return 'Nền tảng: game web offline. Bản tích hợp phải có index.html tự chứa và không phụ thuộc CDN.';
const [bp,bm,rp,rm]=job.uuids;
return `NỀN TẢNG ƯU TIÊN: Minecraft BEDROCK 1.26.0, KHÔNG phải Java Edition, KHÔNG làm game HTML, KHÔNG xuất APK Minecraft.
Add-On gồm BP (Behavior Pack) và RP (Resource Pack). Xuất các file text bằng khối file:BP/... và file:RP/....
Bản tích hợp phải chứa BP/manifest.json và RP/manifest.json, manifest format_version 2, header.min_engine_version [1,26,0], pack version [1,0,0].
UUID cố định: BP header ${bp}, BP data module ${bm}, RP header ${rp}, RP resources module ${rm}. BP.dependencies trỏ tới UUID RP ${rp}, version [1,0,0].
Dùng namespace studio cho identifier. Mỗi loại file có format_version riêng theo schema, không đặt tất cả bằng phiên bản game.
Ưu tiên component ổn định và tài nguyên/âm thanh vanilla. Chỉ có đầu ra text, chưa có công cụ sinh PNG/OGG; không đặt SVG thay texture Minecraft, không khai báo asset tự tạo chưa tồn tại.
Không dùng Forge/Fabric/.jar. Không dùng Script API hay experiments trừ khi brief yêu cầu và có phiên bản module chính xác từ người dùng. Bản tích hợp phải trả toàn bộ file cần thiết, không chỉ dẫn đi tải thêm.
Tên add-on phải giữ đúng tên dự án: ${job.name}. Chưa có khả năng chạy Minecraft; không giả kết quả thử trong game.`;}
function messages(job,node,profiles={}){return [{role:'system',content:`Bạn là ${ROLES[node.role][0]}, ${ROLES[node.role][1]}, nhân viên AI của studio. Trả lời tiếng Việt. Nhiệm vụ này đã được giao: tạo file đầu ra mới rồi bàn giao, không dừng để xin duyệt lại. Nếu thiếu chi tiết nhỏ, ghi giả định hợp lý và làm tiếp. Trở ngại thật phải báo cụ thể, không giả hoàn thành. Không có shell, engine, trình sinh ảnh/âm thanh hay quyền xuất bản. Chỉ kiểm tra tĩnh, không nhận đã chơi thử.\n${profiles[node.role]||''}\n${platform(job)}`},{role:'user',content:`Dự án: ${job.name}\nYêu cầu: ${job.brief}\nPhần việc: ${node.task}\nĐầu ra tiền nhiệm:\n`+ancestors(job,node).map(n=>`## ${ROLES[n.role][0]} / ${n.id}\n${n.text}`).join('\n\n')}];}
function recover(jobs){for(const j of jobs)for(const n of j.nodes)if(n.status==='running'){n.status='interrupted';n.error='Ứng dụng đóng giữa lượt; bấm Thử lại để tránh tự gửi trùng.';}return jobs;}
function validateAddon(files){const errors=[],manifests={},seen=new Set();const version=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isInteger(n)&&n>=0);const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
for(const p of Object.keys(files)){if(!/^(BP|RP)\//.test(p)){errors.push('File ngoài BP/RP: '+p);continue;}if(p.endsWith('.json'))try{JSON.parse(files[p]);}catch(e){errors.push('JSON không hợp lệ: '+p);}if(!/\.(json|js|mcfunction|lang|txt)$/i.test(p))errors.push('Định dạng chưa hỗ trợ: '+p);}
for(const pack of ['BP','RP']){let m;try{m=JSON.parse(files[pack+'/manifest.json']);}catch(e){errors.push('Thiếu hoặc lỗi '+pack+'/manifest.json');continue;}if(!m||typeof m!=='object'||Array.isArray(m)){errors.push(pack+': manifest phải là object');continue;}manifests[pack]=m;
if(m.format_version!==2)errors.push(pack+': yêu cầu manifest 2');if(!m.header?.name||!m.header?.description)errors.push(pack+': thiếu tên/mô tả');if(!version(m.header?.version)||!version(m.header?.min_engine_version))errors.push(pack+': thiếu version/min_engine_version hợp lệ');
if(JSON.stringify(m.header?.min_engine_version)!=='[1,26,0]')errors.push(pack+': cấu hình mục tiêu hiện là [1,26,0]');
const mods=m.modules;if(!Array.isArray(mods)||!mods.some(x=>x?.type===(pack==='BP'?'data':'resources')))errors.push(pack+': thiếu module data/resources');
for(const o of [m.header,...(Array.isArray(mods)?mods:[])]){if(!uuid.test(o?.uuid||''))errors.push(pack+': UUID không hợp lệ');else if(seen.has(o.uuid.toLowerCase()))errors.push(pack+': UUID trùng');else seen.add(o.uuid.toLowerCase());if(!version(o?.version))errors.push(pack+': version module/header không hợp lệ');}
if(Array.isArray(mods)&&mods.some(x=>x?.type==='script'))errors.push('Bản đóng gói đầu chưa xác minh Script API. Hãy dùng component ổn định.');}
if(manifests.BP&&manifests.RP){const rp=manifests.RP.header||{};const d=manifests.BP.dependencies||[];if(!Array.isArray(d)||!d.some(x=>x.uuid===rp.uuid&&JSON.stringify(x.version)===JSON.stringify(rp.version)))errors.push('BP thiếu dependency đúng tới RP.');}
return errors;}
class Scheduler{
constructor(jobs,changed){this.jobs=jobs;this.changed=changed;this.paused=false;this.cooldown=0;this.limit=3;}
ready(now=Date.now(),config=null){const active=this.jobs.flatMap(j=>j.nodes.filter(n=>n.status==='running'));if(active.length>=this.limit)return null;const occupied=new Set(active.map(n=>n.role));if(this.cooldown>now||this.paused)return null;for(const j of this.jobs){if(j.cancelled||(config&&(j.config.endpoint!==config.endpoint||j.config.model!==config.model)))continue;for(const n of j.nodes){if(['queued','waiting'].includes(n.status)&&n.due<=now&&!occupied.has(n.role)&&n.deps.every(id=>j.nodes.find(p=>p.id===id).status==='done'))return {job:j,node:n};}}return null;}
async runOne(work,transport,profiles){const {job,node}=work;node.status='running';this.changed();try{const text=await transport(job.config,messages(job,node,profiles));if(typeof text!=='string'||!text.trim())throw Error('AI không trả nội dung.');node.text=text;node.status='done';node.error='';node.attempt=0;}catch(e){node.attempt++;node.error=e.message||String(e);if(e.retry){node.status='waiting';const delay=Math.max(e.delay||0,Math.min(3600000,30000*2**Math.min(node.attempt-1,7)));node.due=Date.now()+delay;this.cooldown=Math.max(this.cooldown,node.due);if(e.status===429)this.limit=Math.max(1,this.limit-1);}else node.status='failed';}this.changed();}
retry(job){for(const n of job.nodes)if(['failed','waiting','interrupted'].includes(n.status)){n.status='queued';n.due=0;n.error='';}job.cancelled=false;this.paused=false;this.changed();}
}
const api={ROLES,uid,normalize,graph,makeJob,ancestors,filesFrom,platform,messages,recover,validateAddon,Scheduler};if(typeof module!=='undefined')module.exports=api;else root.StudioCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
