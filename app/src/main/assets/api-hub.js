'use strict';
(function(){
 const P=StudioPublicAPIs,$=id=>document.getElementById(id);
 let directory=P.samples.slice(),picked=null,busy=false,requestNo=0;
 const callbacks=new Map();
 try{
   const cached=JSON.parse(localStorage.getItem('publicApiCatalog')||'null');
   if(Array.isArray(cached)&&cached.length&&cached.length<=5000
     &&cached.every(x=>x&&typeof x.name==='string'&&typeof x.category==='string'&&typeof x.url==='string'))directory=cached;
 }catch(e){/* Keep bundled offline examples if storage fails. */}
 window.publicApiResult=function(id,response){const done=callbacks.get(id);if(done){callbacks.delete(id);done(response);}};
 function message(s){$('apiStatus').textContent=s;}
 function get(url){
   if(!window.NativeStudio||typeof NativeStudio.publicGet!=='function')return Promise.reject(Error('Chỉ gọi được API trong APK Android mới.'));
   if(!NativeStudio.online())return Promise.reject(Error('Thiết bị offline; vẫn tra cứu được danh mục.'));
   return new Promise((resolve,reject)=>{
     const id='api-get-'+(++requestNo);callbacks.set(id,resolve);
     try{NativeStudio.publicGet(id,JSON.stringify({url}));}
     catch(e){callbacks.delete(id);reject(e);}
   });
 }
 function addToBrief(s){
   if($('brief').value.length+s.length>25000){message('Yêu cầu quá dài, hãy rút gọn trước khi thêm.');return;}
   $('brief').value+=s;
   document.querySelector('[data-tab="tasks"]').click();
   $('notice').textContent='Đã thêm tham khảo API. Kiểm tra yêu cầu rồi bấm GIAO VIỆC để đội AI xử lý.';
 }
 function renderCategories(){
   const select=$('apiCategory'),previous=select.value;select.replaceChildren();
   const all=document.createElement('option');all.value='';all.textContent='Tất cả nhóm';select.append(all);
   for(const name of [...new Set(directory.map(x=>x.category))].sort()){
     const o=document.createElement('option');o.value=name;o.textContent=name;select.append(o);
   }
   if([...select.options].some(x=>x.value===previous))select.value=previous;
 }
 function renderDirectory(){
   const query=$('apiSearch').value.trim().toLowerCase(),category=$('apiCategory').value;
   const found=directory.filter(x=>(!category||x.category===category)
     &&(!query||(x.name+' '+x.category+' '+x.description).toLowerCase().includes(query)));
   $('apiCount').textContent=found.length+' kết quả • hiển thị 30 mục đầu';
   const list=$('apiList');list.replaceChildren();
   for(const item of found.slice(0,30)){
     const card=document.createElement('article');card.className='card api-entry';
     const h=document.createElement('strong');h.textContent=item.name+' • '+item.category;card.append(h);
     const desc=document.createElement('p');desc.textContent=item.description;card.append(desc);
     const link=document.createElement('p');link.className='api-url';link.textContent=item.url;card.append(link);
     const add=document.createElement('button');add.textContent='Thêm mô tả vào yêu cầu';
     add.onclick=()=>addToBrief(P.reference(item));card.append(add);list.append(card);
   }
 }
 function renderSamples(){
   const container=$('apiFeatured');container.replaceChildren();
   for(const item of P.samples){
     const card=document.createElement('article');card.className='card api-entry';
     const label=document.createElement('strong');label.textContent=item.name;card.append(label);
     const desc=document.createElement('p');desc.textContent=item.description;card.append(desc);
     const button=document.createElement('button');button.textContent='Thử GET mẫu';
     button.onclick=async()=>{
       if(busy)return;busy=true;button.disabled=true;picked=null;$('apiAttach').disabled=true;
       $('apiPreview').textContent='Đang lấy dữ liệu...';
       try{
         const response=await get(item.url);
         if(!response.ok)throw Error(response.error||('HTTP '+response.status));
         const raw=response.body||'';
         try{$('apiPreview').textContent=JSON.stringify(JSON.parse(raw),null,2).slice(0,5500);}
         catch(e){$('apiPreview').textContent=raw.slice(0,5500);}
         picked={item,raw};$('apiAttach').disabled=false;
         message('Đã lấy dữ liệu từ '+item.name+'. Có thể đưa kết quả vào yêu cầu.');
       }catch(e){$('apiPreview').textContent='Lỗi: '+e.message;message('Không gọi được API mẫu.');}
       finally{busy=false;button.disabled=false;}
     };
     card.append(button);container.append(card);
   }
 }
 $('apiAttach').onclick=()=>{if(picked)addToBrief(P.apiAttachment(picked.item,picked.raw));};
 $('apiSearch').oninput=renderDirectory;$('apiCategory').onchange=renderDirectory;
 $('apiSync').onclick=async()=>{
   if(busy)return;busy=true;$('apiSync').disabled=true;message('Đang tải danh mục từ GitHub...');
   try{
     const response=await get(P.SOURCE);
     if(!response.ok)throw Error(response.error||('HTTP '+response.status));
     const parsed=P.parseDirectory(response.body||'');
     if(parsed.length<100)throw Error('README thiếu danh mục hợp lệ.');
     directory=parsed;
     let saved=true;
     try{localStorage.setItem('publicApiCatalog',JSON.stringify(directory));}catch(e){saved=false;}
     renderCategories();renderDirectory();
     message('Đã cập nhật '+directory.length+' mục từ GitHub.'+(saved?' Có thể tra cứu offline.':' Không lưu được bộ nhớ offline.'));
   }catch(e){message('Không cập nhật được: '+e.message+'. Danh mục cũ vẫn được giữ.');}
   finally{busy=false;$('apiSync').disabled=false;}
 };
 renderSamples();renderCategories();renderDirectory();
 message(directory.length===P.samples.length?'Đang dùng danh mục mẫu offline. Bấm Cập nhật để tải danh mục đầy đủ.':'Đang sử dụng '+directory.length+' mục đã lưu offline.');
})();
