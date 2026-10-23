'use strict';
(function(){
 const C=StudioCore,$=id=>document.getElementById(id),STORE='bedrockPackProjectsV1';
 let packs=[],activeProjectId='',activeFile='',deleteArmed='';
 try{
   const stored=JSON.parse(localStorage.getItem(STORE)||'[]');
   if(!Array.isArray(stored)||!stored.every(p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&p.files&&typeof p.files==='object'&&!Array.isArray(p.files)))
     throw Error('Dữ liệu dự án gói không hợp lệ');
   packs=stored;
 }catch(e){
   $('packResult').textContent='Không thể đọc bản lưu BP/RP. Chưa ghi đè dữ liệu cũ: '+e.message;
   return;
 }
 function current(){return packs.find(p=>p.id===activeProjectId)||null;}
 function status(text){$('packResult').textContent=text;}
 function persist(){
   try{localStorage.setItem(STORE,JSON.stringify(packs));return true;}
   catch(e){status('Không lưu được BP/RP vào bộ nhớ. Không tạo hay cập nhật dữ liệu mới.');return false;}
 }
 function check(project){
   const files=project.files,issues=C.validateAddon(files);
   let size=0;
   for(const [path,content] of Object.entries(files)){
     if(!C.safePackPath(path))issues.push('Tên file không hợp lệ: '+path);
     if(typeof content!=='string'||content.length>100000)issues.push('File quá lớn hoặc không phải văn bản: '+path);
     size+=typeof content==='string'?content.length:0;
   }
   if(size>4000000)issues.push('Tổng nội dung BP/RP quá lớn.');
   return issues;
 }
 function saveActive(){
   const project=current();
   if(!project||!activeFile)return true;
   const content=$('packContent').value;
   if(project.files[activeFile]===content)return true;
   if(content.length>100000){status('File quá 100.000 ký tự, chưa lưu.');return false;}
   if(activeFile.endsWith('.json')){
     try{JSON.parse(content);}
     catch(e){status('JSON không hợp lệ trong '+activeFile+': '+e.message);return false;}
   }
   const old=project.files[activeFile];project.files[activeFile]=content;
   if(!persist()){project.files[activeFile]=old;return false;}
   return true;
 }
 function showContent(){
   const project=current(),exists=!!project&&!!activeFile;
   $('packContent').disabled=!exists;$('packSave').disabled=!exists;
   $('packDelete').disabled=!exists||activeFile.endsWith('/manifest.json');
   $('packContent').value=exists?(project.files[activeFile]||''):'';
 }
 function showFiles(selectPath=''){
   const project=current(),list=$('packFile');list.replaceChildren();
   if(project){
     const paths=Object.keys(project.files).sort((a,b)=>a.localeCompare(b));
     for(const path of paths){const opt=document.createElement('option');opt.value=path;opt.textContent=path;list.append(opt);}
     activeFile=paths.includes(selectPath)?selectPath:paths[0]||'';
   }else activeFile='';
   if(activeFile)list.value=activeFile;
   list.disabled=!project;deleteArmed='';showContent();
   $('packSaveAddon').disabled=!project;
   $('packSaveBP').disabled=!project;
   $('packSaveRP').disabled=!project;
   $('packAdd').disabled=!project;
   $('packCheck').disabled=!project;
 }
 function showProjects(selected=''){
   const list=$('packProject');list.replaceChildren();
   const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Chọn bộ BP/RP đã tạo';list.append(placeholder);
   for(const p of packs){const opt=document.createElement('option');opt.value=p.id;opt.textContent=p.name;list.append(opt);}
   activeProjectId=packs.some(p=>p.id===selected)?selected:'';
   list.value=activeProjectId;
   showFiles();
 }
 $('packProject').onchange=()=>{
   const next=$('packProject').value;
   if(!saveActive()){$('packProject').value=activeProjectId;return;}
   activeProjectId=next;showFiles();
 };
 $('packFile').onchange=()=>{
   const next=$('packFile').value;
   if(!saveActive()){$('packFile').value=activeFile;return;}
   activeFile=next;deleteArmed='';showContent();
 };
 $('packSave').onclick=()=>{
   if(saveActive())status('Đã lưu nội dung '+activeFile+' trên thiết bị.');
 };
 $('packCreate').onclick=()=>{
   if(!saveActive())return;
   const pack=C.createPackPair($('packName').value);
   packs.unshift(pack);
   if(!persist()){packs.shift();return;}
   showProjects(pack.id);
   $('packName').value=pack.name;
   status('Đã tạo BP/manifest.json và RP/manifest.json; UUID và dependency đã liên kết. Không cần Internet hoặc API key.');
 };
 $('packImportAI').onclick=()=>{
   if(!saveActive())return;
   try{
     if(typeof window.StudioGetSelectedAddon!=='function')throw Error('Không có dữ liệu AI khả dụng.');
     const source=window.StudioGetSelectedAddon();
     const pack=C.createPackPair(source.name,source.uuids);
     let imported=0,skipped=0;
     for(const [path,content] of Object.entries(source.files)){
       if(!C.safePackPath(path)||path.endsWith('/manifest.json')||typeof content!=='string'){skipped++;continue;}
       pack.files[path]=content;imported++;
     }
     packs.unshift(pack);
     if(!persist()){packs.shift();return;}
     showProjects(pack.id);
     status('Đã nhập '+imported+' file từ AI vào BP/RP, giữ manifest chuẩn; bỏ qua '+skipped+' file không hợp lệ/manifest AI. Hãy kiểm tra và sửa trước khi xuất.');
   }catch(e){status('Chưa nhập được: '+e.message);}
 };
 $('packAdd').onclick=()=>{
   const project=current();if(!project)return;
   if(!saveActive())return;
   const path=$('packNewFile').value.trim();
   if(!C.safePackPath(path)){status('Đường dẫn chỉ thuộc BP/ hoặc RP/ và phải là file văn bản .json/.js/.txt/.lang/.mcfunction.');return;}
   if(Object.hasOwn(project.files,path)){status('File đã tồn tại: '+path);return;}
   if(Object.keys(project.files).length>=2000){status('Vượt số file cho phép.');return;}
   project.files[path]=path.endsWith('.json')?'{}\n':'';
   if(!persist()){delete project.files[path];return;}
   showFiles(path);$('packNewFile').value='';
   status('Đã thêm '+path+'. Hãy sửa nội dung theo schema Minecraft trước khi dùng.');
 };
 $('packDelete').onclick=()=>{
   const project=current();if(!project||!activeFile||activeFile.endsWith('/manifest.json'))return;
   if(deleteArmed!==activeFile){deleteArmed=activeFile;status('Bấm “Xóa file” thêm một lần để xác nhận xóa '+activeFile);return;}
   const old=project.files[activeFile];delete project.files[activeFile];
   if(!persist()){project.files[activeFile]=old;return;}
   showFiles();status('Đã xóa file; hai manifest BP/RP vẫn được giữ.');
 };
 $('packCheck').onclick=()=>{
   const project=current();if(!project||!saveActive())return;
   const errors=check(project);
   status(errors.length?errors.join('\n'):'BP và RP đạt kiểm tra cấu trúc manifest; chưa kiểm thử gameplay trong Minecraft.');
 };
 function exportFiles(pack){
   const project=current();if(!project||!saveActive())return;
   const problems=check(project);
   if(problems.length){status(problems.join('\n'));return;}
   if(!window.NativeStudio){status('Chỉ lưu file được trong bản APK Android.');return;}
   const files=JSON.stringify(project.files);
   if(pack==='ADDON')NativeStudio.exportAddon(files,project.name);
   else{
     if(typeof NativeStudio.exportPack!=='function'){status('Cần APK mới có chức năng xuất BP/RP riêng.');return;}
     NativeStudio.exportPack(files,project.name,pack);
   }
   status('Đã mở trình lưu '+(pack==='ADDON'?'.mcaddon':pack+'.mcpack')+'. Hãy chọn vị trí lưu trong Android.');
 }
 $('packSaveBP').onclick=()=>exportFiles('BP');
 $('packSaveRP').onclick=()=>exportFiles('RP');
 $('packSaveAddon').onclick=()=>exportFiles('ADDON');
 showProjects();
})();
