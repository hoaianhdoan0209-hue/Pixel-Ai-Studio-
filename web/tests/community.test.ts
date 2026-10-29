import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createApp } from '../server/app.js';

function zipFile(filename:string,content:string){
  const name=Buffer.from(filename),data=Buffer.from(content);
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+data.length,16);
  return Buffer.concat([local,name,data,central,name,end]);
}

test('Phase 2 community discovery, uploads, moderation and publishing persist with ownership boundaries',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'pixel-community-'));
  let runtime:ReturnType<typeof createApp>,server:Server,base='';
  const start=async()=>{runtime=createApp({dataDir,allowFirstAdmin:true});server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}`;};
  const stop=async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));runtime.close();};
  function client(){
    let cookie='';
    return async(path:string,method='GET',data?:unknown)=>{
      const isForm=data instanceof FormData;
      const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined&&!isForm?{'Content-Type':'application/json'}:{})},...(data===undefined?{}:{body:isForm?data:JSON.stringify(data)})});
      const set=response.headers.getSetCookie()[0];if(set)cookie=set.split(';')[0];
      const content=await response.arrayBuffer(),mime=response.headers.get('content-type')||'';
      return {status:response.status,headers:response.headers,bytes:Buffer.from(content),body:mime.includes('application/json')?JSON.parse(Buffer.from(content).toString()):null};
    };
  }
  const admin=client(),author=client(),member=client(),guest=client();
  let authorId='',memberId='',postId='',draftId='',imageId='',fileId='',archiveId='',commentId='',reportId='';
  const sendFile=async(c:ReturnType<typeof client>,buffer:Buffer,name:string,purpose:string,post?:string)=>{
    const data=new FormData();data.set('purpose',purpose);if(post)data.set('postId',post);data.set('file',new Blob([new Uint8Array(buffer)]),name);return c('/media','POST',data);
  };
  await start();
  try{
    await t.test('registration and backend authorization protect writes and private drafts',async()=>{
      for(const [c,name,email] of [[admin,'Kiểm duyệt','mod@example.test'],[author,'Tác giả','author@example.test'],[member,'Độc giả','reader@example.test']] as const){const response=await c('/auth/register','POST',{name,email,password:'Community-password!'});assert.equal(response.status,201);if(c===author)authorId=response.body.user.id;if(c===member)memberId=response.body.user.id;}
      assert.equal((await guest('/community/posts','POST',{title:'Không được',description:'Nội dung'})).status,401);
      const post=await author('/community/posts','POST',{title:'Khu rừng trăm hoa',description:'Game phiêu lưu đồng sáng tạo',genre:'Phiêu lưu',platform:'Web',category:'Khám phá',developmentStatus:'recruiting'});
      assert.equal(post.status,201);postId=post.body.post.id;
      const draft=await author('/community/posts','POST',{title:'Thảo luận riêng',description:'Bản nháp thảo luận',kind:'discussion',status:'draft',platform:'Android'});
      assert.equal(draft.status,201);draftId=draft.body.post.id;
      assert.equal((await guest('/community/posts/'+draftId)).status,404);
      assert.equal((await member('/community/posts/'+draftId,'PATCH',{title:'Không được',version:1})).status,404);
      assert.equal((await member('/community/posts/'+postId,'PATCH',{title:'Không được',version:1})).status,403);
    });
    await t.test('real feed filters, pagination, discussion type and escaped search produce accurate totals',async()=>{
      const feed=await guest('/community/feed?genre='+encodeURIComponent('Phiêu lưu')+'&platform=Web&category='+encodeURIComponent('Khám phá')+'&developmentStatus=recruiting&pageSize=1');
      assert.equal(feed.status,200);assert.equal(feed.body.total,1);assert.equal(feed.body.posts[0].id,postId);assert.equal(feed.body.hasMore,false);assert.ok(feed.body.facets.categories.includes('Khám phá'));
      const own=await author('/community/feed?filter=mine&kind=discussion');assert.equal(own.body.total,1);assert.equal(own.body.posts[0].id,draftId);
      assert.equal((await guest('/community/feed?q=%25')).body.total,0);
      assert.equal((await guest('/community/feed?pageSize=10000')).status,400);
      const page=await guest('/community/feed?page=2&pageSize=1');assert.equal(page.body.total,1);assert.equal(page.body.posts.length,0);
    });
    await t.test('version checks prevent metadata overwrite and require validated HTTPS links',async()=>{
      const update=await author('/community/posts/'+postId,'PATCH',{version:1,category:'Game cộng tác',playUrl:'https://example.test/game'});assert.equal(update.status,200);assert.equal(update.body.post.version,2);
      assert.equal((await author('/community/posts/'+postId,'PATCH',{version:1,category:'Mất cập nhật'})).status,409);
      assert.equal((await author('/community/posts/'+postId,'PATCH',{version:2,playUrl:'javascript:alert(1)'})).status,400);
    });
    await t.test('ratings are unique per account, updatable and bounded; self-ratings are denied',async()=>{
      assert.equal((await member('/posts/'+postId+'/rating','POST',{value:6})).status,400);
      assert.equal((await author('/posts/'+postId+'/rating','POST',{value:5})).status,400);
      let result=await member('/posts/'+postId+'/rating','POST',{value:3});assert.equal(result.status,200);assert.deepEqual(result.body.post.rating,{count:1,average:3,mine:3});
      result=await member('/posts/'+postId+'/rating','POST',{value:5});assert.equal(result.body.post.rating.count,1);assert.equal(result.body.post.rating.average,5);
      assert.equal((await member('/posts/'+postId+'/rating','DELETE')).body.post.rating.count,0);
    });
    await t.test('following authors updates real discovery and emits a notification',async()=>{
      assert.equal((await author('/profiles/'+authorId+'/follow','POST')).status,400);
      const following=await member('/profiles/'+authorId+'/follow','POST');assert.equal(following.status,200);assert.equal(following.body.following,true);
      assert.equal((await member('/community/feed?filter=following')).body.total,1);
      const profile=await guest('/profiles/'+authorId+'/community');assert.equal(profile.body.followers,1);assert.equal(profile.body.posts.length,1);assert.equal(profile.body.author.email,undefined);
      assert.ok((await author('/notifications')).body.notifications.some((n:any)=>n.type==='follow'));
      assert.equal((await member('/profiles/'+authorId+'/follow','POST')).body.following,false);
      assert.equal((await member('/community/feed?filter=following')).body.total,0);
    });
    await t.test('image uploads validate pixels and ownership and reencode metadata-free WebP',async()=>{
      const png=await sharp({create:{width:8,height:8,channels:3,background:'#4a6a42'}}).png().toBuffer();
      const response=await sendFile(author,png,'cover.png','post',postId);assert.equal(response.status,201);assert.equal(response.body.media.mime,'image/webp');imageId=response.body.media.id;
      const content=await guest('/media/'+imageId+'/content');assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'image/webp');const meta=await sharp(content.bytes).metadata();assert.equal(meta.format,'webp');assert.equal(meta.exif,undefined);
      assert.equal((await sendFile(member,png,'other.png','post',postId)).status,403);
      assert.equal((await sendFile(author,Buffer.from('<svg onload="alert(1)"/>'),'avatar.svg','avatar')).status,400);
      assert.equal((await sendFile(author,Buffer.from('<html>not an image</html>'),'fake.png','post',postId)).status,400);
      const detail=await guest('/community/posts/'+postId);assert.equal(detail.body.post.cover.id,imageId);assert.equal(detail.body.post.media.length,1);
      const avatar=await sendFile(author,png,'avatar.png','avatar');assert.equal(avatar.status,201);assert.equal((await guest('/media/'+avatar.body.media.id+'/content')).status,200);
    });
    await t.test('draft attachments are private and downloads cannot execute on the trusted origin',async()=>{
      const response=await sendFile(author,Buffer.from('<script>alert(document.cookie)</script>'),'notes.txt','attachment',draftId);assert.equal(response.status,201);fileId=response.body.media.id;
      assert.equal((await guest('/media/'+fileId+'/content')).status,404);
      assert.equal((await member('/media/'+fileId+'/content')).status,404);
      const own=await author('/media/'+fileId+'/content');assert.equal(own.status,200);assert.match(own.headers.get('content-disposition')!,/^attachment;/);assert.match(own.headers.get('content-security-policy')!,/sandbox/);assert.equal(own.headers.get('x-content-type-options'),'nosniff');
      assert.equal((await sendFile(member,Buffer.from('{}'),'notes.json','attachment',draftId)).status,403);
      assert.equal((await sendFile(member,Buffer.from('bad json'),'bad.json','attachment',postId)).status,403);
      assert.equal((await sendFile(author,Buffer.from('bad json'),'bad.json','attachment',draftId)).status,400);
      assert.equal((await sendFile(author,Buffer.from('PK\u0003\u0004'+'x'.repeat(30)),'bad.zip','attachment',draftId)).status,400);
    });
    await t.test('valid game archives download unchanged while traversal and excessive image sizes are rejected',async()=>{
      const archive=zipFile('index.html','<!doctype html><h1>Game package</h1>');
      const uploaded=await sendFile(author,archive,'game.zip','attachment',postId);assert.equal(uploaded.status,201);archiveId=uploaded.body.media.id;
      const downloaded=await guest('/media/'+archiveId+'/content');assert.equal(downloaded.status,200);assert.deepEqual(downloaded.bytes,archive);assert.match(downloaded.headers.get('content-disposition')!,/^attachment;/);
      const memberDraft=await member('/community/posts','POST',{title:'Bản nháp kiểm thử tệp',description:'Dùng để kiểm tra quyền upload',status:'draft'});assert.equal(memberDraft.status,201);
      assert.equal((await sendFile(member,zipFile('../escape.txt','bad'),'unsafe.zip','attachment',memberDraft.body.post.id)).status,400);
      assert.equal((await sendFile(member,Buffer.alloc(5*1024*1024+1),'large.png','avatar')).status,413);
      assert.equal((await sendFile(member,Buffer.from('fake'),'../escape.png','avatar')).status,400);
    });
    await t.test('moderation is role-protected and hides posts across feed, detail and media routes',async()=>{
      const comment=await member('/posts/'+postId+'/comments','POST',{body:'Một góp ý có thể cần kiểm duyệt.'});assert.equal(comment.status,201);commentId=comment.body.comment.id;
      const reported=await member('/reports','POST',{targetType:'post',targetId:postId,reason:'Nội dung cần xem xét theo quy định.'});assert.equal(reported.status,201);reportId=reported.body.report.id;
      assert.equal((await member('/reports','POST',{targetType:'post',targetId:postId,reason:'Báo cáo trùng đang chờ.'})).status,409);
      assert.equal((await member('/moderation/reports')).status,403);
      assert.equal((await member('/moderation/reports/'+reportId+'/resolve','POST',{action:'hide',note:'Không đủ quyền'})).status,403);
      assert.ok((await admin('/moderation/reports')).body.reports.some((r:any)=>r.id===reportId));
      assert.equal((await admin('/moderation/reports/'+reportId+'/resolve','POST',{action:'hide',note:'Ẩn trong khi xử lý phản ánh.'})).status,200);
      assert.equal((await guest('/community/feed')).body.total,0);
      assert.equal((await guest('/community/posts/'+postId)).status,404);
      assert.equal((await guest('/posts/'+postId)).status,404);
      assert.equal((await guest('/posts')).body.posts.length,0);
      assert.equal((await guest('/media/'+imageId+'/content')).status,404);
      assert.equal((await author('/community/posts/'+postId)).body.post.hidden,true);
      assert.equal((await member('/posts/'+postId+'/rating','POST',{value:5})).status,404);
      assert.equal((await admin('/moderation/reports/'+reportId+'/resolve','POST',{action:'restore',note:'Đã xem xét và khôi phục.'})).status,200);
      assert.equal((await guest('/community/feed')).body.total,1);
      assert.equal((await guest('/media/'+imageId+'/content')).status,200);
    });
    await t.test('comment reports hide only the selected comment and maintain an audited resolution',async()=>{
      const report=await author('/reports','POST',{targetType:'comment',targetId:commentId,reason:'Nội dung bình luận cần xem xét.'});assert.equal(report.status,201);
      assert.equal((await admin('/moderation/reports/'+report.body.report.id+'/resolve','POST',{action:'hide',note:'Đã xử lý bình luận này.'})).status,200);
      assert.equal((await guest('/community/posts/'+postId)).body.comments.length,0);
      assert.equal((await guest('/posts/'+postId)).body.comments.length,0);
      assert.equal((await member('/community/posts/'+postId)).body.comments.length,1);
      const actions=runtime.db.prepare('SELECT * FROM moderation_actions').all();assert.equal(actions.length,3);
    });
    await t.test('game releases enforce unique versions and attachment ownership',async()=>{
      assert.equal((await member('/posts/'+postId+'/releases','POST',{version:'1.0',changelog:'Không được tạo'})).status,403);
      assert.equal((await author('/posts/'+postId+'/releases','POST',{version:'1.0',changelog:'Bản mới',mediaId:fileId})).status,400);
      const release=await author('/posts/'+postId+'/releases','POST',{version:'1.0',changelog:'Bản phát hành đầu tiên',mediaId:archiveId});assert.equal(release.status,201);assert.equal(release.body.release.media.id,archiveId);
      assert.equal((await author('/posts/'+postId+'/releases','POST',{version:'1.0',changelog:'Trùng phiên bản'})).status,409);
      assert.equal((await author('/media/'+archiveId,'DELETE')).status,409);
      assert.equal((await guest('/posts/'+postId+'/releases')).body.releases.length,1);
      assert.equal((await member('/media/'+imageId,'DELETE')).status,404);
    });
    await t.test('media quotas are enforced in database-backed accounting',async()=>{
      const originalSize=runtime.db.prepare('SELECT size FROM media WHERE id=?').get(fileId)!.size;
      runtime.db.prepare('UPDATE media SET size=104857600 WHERE id=?').run(fileId);
      const response=await sendFile(author,Buffer.from('{}'),'quota.json','attachment',draftId);
      assert.equal(response.status,413);
      runtime.db.prepare('UPDATE media SET size=? WHERE id=?').run(originalSize,fileId);
    });
    await t.test('a full server restart retains public content, ratings, private ownership and media bytes',async()=>{
      await stop();await start();
      const feed=await guest('/community/feed');assert.equal(feed.status,200);assert.equal(feed.body.total,1);assert.equal(feed.body.posts[0].id,postId);
      assert.equal((await guest('/posts/'+postId+'/releases')).body.releases.length,1);
      assert.equal((await guest('/community/posts/'+draftId)).status,404);
      const image=await guest('/media/'+imageId+'/content');assert.equal(image.status,200);
      const stored=runtime.db.prepare('SELECT storage_name FROM media WHERE id=?').get(imageId)!;assert.deepEqual(image.bytes,await readFile(join(dataDir,'media',String(stored.storage_name))));
      assert.equal((await author('/community/feed?filter=mine')).body.total,2);
      assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=4').get()!.n),1);
    });
  }finally{await stop();await rm(dataDir,{recursive:true,force:true});}
});
