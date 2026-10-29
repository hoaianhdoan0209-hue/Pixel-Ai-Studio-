import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Response } from 'express';
import { HttpError, type ModuleContext, type Row } from './context.js';
import { mediaShape, registerMedia } from './media.js';

const timestamp = () => new Date().toISOString();
const title = z.string().trim().min(2).max(100);
const body = z.string().trim().min(1).max(20000);
const label = z.string().trim().max(100);
const safeUrl = z.union([z.literal(''), z.url().max(2000).refine(value => new URL(value).protocol === 'https:')]);
const metadata = z.object({category: label.min(1).optional(), kind: z.enum(['game','discussion']).optional(), developmentStatus: z.enum(['development','released','recruiting']).optional()});
const postInput = metadata.extend({title, description: body, genre: label.optional(), technology: label.optional(), aiTools: label.optional(), platform: label.optional(), status: z.enum(['published','draft']).optional(), repositoryUrl: safeUrl.optional(), playUrl: safeUrl.optional()});
const moderator = (user?: Row) => !!user && JSON.parse(user.roles).some((role: string) => ['admin','moderator'].includes(role));

export function registerCommunity(ctx: ModuleContext) {
  const { app, one, all, run, transaction, authenticated, uid, route, audit, notify } = ctx;
  registerMedia(ctx);

  const postRow = (postId: string, viewer?: Row) => {
    const post = one('SELECT p.*, u.name AS author_name FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?',postId);
    if (!post || ((post.status === 'draft' || post.hidden_at) && post.author_id !== viewer?.id && !moderator(viewer))) throw new HttpError(404,'Bài viết không tồn tại.');
    return post;
  };
  const editPost = (post: Row, res: Response) => {
    if (post.author_id !== uid(res) && !JSON.parse(res.locals.user.roles).includes('admin')) throw new HttpError(403,'Bạn không có quyền sửa bài viết này.');
  };
  const published = (post: Row) => { if (post.status !== 'published' || post.hidden_at) throw new HttpError(404,'Bài viết không còn công khai.'); };
  const shape = (post: Row, viewer?: string) => {
    const rating = one('SELECT COUNT(*) AS count,COALESCE(AVG(value),0) AS average FROM ratings WHERE post_id=?',post.id)!;
    const media = all('SELECT * FROM media WHERE post_id=? ORDER BY created_at,id LIMIT 50',post.id).map(mediaShape);
    return {
      id:post.id,title:post.title,description:post.description,genre:post.genre,technology:post.technology,aiTools:post.ai_tools,platform:post.platform,status:post.status,
      repositoryUrl:post.repository_url,playUrl:post.play_url,category:post.category,kind:post.kind,developmentStatus:post.development_status,views:post.views,
      hidden:!!post.hidden_at,hiddenReason:post.author_id===viewer?post.hidden_reason:undefined,
      author:{id:post.author_id,name:post.author_name || one('SELECT name FROM users WHERE id=?',post.author_id)?.name},
      likes:one("SELECT COUNT(*) AS n FROM reactions WHERE post_id=? AND type='like'",post.id)!.n,
      comments:one('SELECT COUNT(*) AS n FROM comments WHERE post_id=? AND hidden_at IS NULL',post.id)!.n,
      liked:!!viewer && !!one("SELECT 1 FROM reactions WHERE post_id=? AND user_id=? AND type='like'",post.id,viewer),
      bookmarked:!!viewer && !!one("SELECT 1 FROM reactions WHERE post_id=? AND user_id=? AND type='bookmark'",post.id,viewer),
      rating:{count:Number(rating.count),average:Math.round(Number(rating.average)*100)/100,mine:viewer?one('SELECT value FROM ratings WHERE post_id=? AND user_id=?',post.id,viewer)?.value || null:null},
      media,cover:media.find(item=>item.kind==='image') || null,version:post.version,createdAt:post.created_at,updatedAt:post.updated_at,
    };
  };
  const releaseShape = (release: Row) => ({id:release.id,postId:release.post_id,version:release.version,changelog:release.changelog,media:release.media_id?mediaShape(one('SELECT * FROM media WHERE id=?',release.media_id)!):null,createdAt:release.created_at});

  app.get('/api/community/feed',route((req,res)=>{
    const q=z.object({q:z.string().max(200).default(''),genre:label.default(''),platform:label.default(''),category:label.default(''),kind:z.enum(['game','discussion']).optional(),developmentStatus:z.enum(['development','released','recruiting']).optional(),filter:z.enum(['all','mine','bookmarks','following']).default('all'),sort:z.enum(['recent','popular','updated','views']).default('recent'),page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(50).default(12)}).parse(req.query);
    const viewer=res.locals.user?.id || '';
    const clauses=["(p.status='published' OR p.author_id=?)",'(p.hidden_at IS NULL OR (?=\'mine\' AND p.author_id=?))'];
    const params:any[]=[viewer,q.filter,viewer];
    if(q.q){clauses.push('(p.title LIKE ? ESCAPE \'\\\' OR p.description LIKE ? ESCAPE \'\\\')');const term='%'+q.q.replace(/[\\%_]/g,'\\$&')+'%';params.push(term,term);}
    for(const field of ['genre','platform','category'] as const)if(q[field]){clauses.push(`p.${field}=?`);params.push(q[field]);}
    if(q.kind){clauses.push('p.kind=?');params.push(q.kind);}
    if(q.developmentStatus){clauses.push('p.development_status=?');params.push(q.developmentStatus);}
    if(q.filter==='mine'){clauses.push('p.author_id=?');params.push(viewer);}
    if(q.filter==='bookmarks'){clauses.push("EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=? AND r.type='bookmark')");params.push(viewer);}
    if(q.filter==='following'){clauses.push('EXISTS(SELECT 1 FROM follows f WHERE f.author_id=p.author_id AND f.follower_id=?)');params.push(viewer);}
    const where=clauses.join(' AND ');
    const order=q.sort==='popular'?"(SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.type='like') DESC,p.created_at DESC":q.sort==='views'?'p.views DESC,p.created_at DESC':q.sort==='updated'?'p.updated_at DESC,p.id':'p.created_at DESC,p.id';
    const total=Number(one(`SELECT COUNT(*) AS n FROM posts p WHERE ${where}`,...params)!.n);
    const posts=all(`SELECT p.*,u.name AS author_name FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,...params,q.pageSize,(q.page-1)*q.pageSize).map(post=>shape(post,viewer));
    const values=(column:string)=>all(`SELECT DISTINCT ${column} AS value FROM posts WHERE status='published' AND hidden_at IS NULL AND ${column}<>'' ORDER BY ${column} LIMIT 100`).map(row=>row.value);
    res.json({posts,total,page:q.page,pageSize:q.pageSize,hasMore:q.page*q.pageSize<total,facets:{genres:values('genre'),platforms:values('platform'),categories:values('category')}});
  }));

  app.post('/api/community/posts',authenticated,route((req,res)=>{
    const data=postInput.parse(req.body),postId=randomUUID();
    transaction(()=>{
      run('INSERT INTO posts(id,author_id,title,description,genre,technology,ai_tools,platform,status,repository_url,play_url,category,kind,development_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',postId,uid(res),data.title,data.description,data.genre||'',data.technology||'',data.aiTools||'',data.platform||'Web',data.status||'published',data.repositoryUrl||'',data.playUrl||'',data.category||'Game',data.kind||'game',data.developmentStatus||'development',timestamp(),timestamp());
      audit(uid(res),null,'community.post_created',postId);
    });
    res.status(201).json({post:shape(postRow(postId,res.locals.user),uid(res))});
  }));
  app.patch('/api/community/posts/:id',authenticated,route((req,res)=>{
    const post=postRow(String(req.params.id),res.locals.user);editPost(post,res);
    const data=postInput.partial().extend({version:z.number().int().positive()}).parse(req.body);
    transaction(()=>{
      const result=run('UPDATE posts SET title=?,description=?,genre=?,technology=?,ai_tools=?,platform=?,status=?,repository_url=?,play_url=?,category=?,kind=?,development_status=?,version=version+1,updated_at=? WHERE id=? AND version=?',data.title??post.title,data.description??post.description,data.genre??post.genre,data.technology??post.technology,data.aiTools??post.ai_tools,data.platform??post.platform,data.status??post.status,data.repositoryUrl??post.repository_url,data.playUrl??post.play_url,data.category??post.category,data.kind??post.kind,data.developmentStatus??post.development_status,timestamp(),post.id,data.version);
      if(!result.changes)throw new HttpError(409,'Bài viết đã thay đổi. Hãy tải lại trước khi lưu.','VERSION_CONFLICT');
      audit(uid(res),null,'community.post_updated',post.id);
    });
    res.json({post:shape(postRow(post.id,res.locals.user),uid(res))});
  }));
  app.get('/api/community/posts/:id',route((req,res)=>{
    const post=postRow(String(req.params.id),res.locals.user);
    // Count distinct resource reads, not feed impressions. It is intentionally an access counter, not analytics about unique people.
    run('UPDATE posts SET views=views+1 WHERE id=?',post.id);post.views+=1;
    const comments=all('SELECT c.*,u.name AS author_name FROM comments c JOIN users u ON u.id=c.author_id WHERE c.post_id=? AND (c.hidden_at IS NULL OR c.author_id=? OR ?=1) ORDER BY c.created_at,c.id LIMIT 500',post.id,res.locals.user?.id||'',moderator(res.locals.user)?1:0).map(comment=>({id:comment.id,postId:comment.post_id,parentId:comment.parent_id,body:comment.body,author:{id:comment.author_id,name:comment.author_name},hidden:!!comment.hidden_at,createdAt:comment.created_at}));
    res.json({post:shape(post,res.locals.user?.id),comments,releases:all('SELECT * FROM game_releases WHERE post_id=? ORDER BY created_at DESC,id',post.id).map(releaseShape),followingAuthor:!!res.locals.user&&!!one('SELECT 1 FROM follows WHERE follower_id=? AND author_id=?',uid(res),post.author_id)});
  }));
  app.get('/api/posts/:id/media',route((req,res)=>{const post=postRow(String(req.params.id),res.locals.user);res.json({media:all('SELECT * FROM media WHERE post_id=? ORDER BY created_at,id LIMIT 100',post.id).map(mediaShape)});}));
  app.post('/api/posts/:id/rating',authenticated,route((req,res)=>{
    const post=postRow(String(req.params.id),res.locals.user);published(post);
    const {value}=z.object({value:z.number().int().min(1).max(5)}).parse(req.body);
    if(post.author_id===uid(res))throw new HttpError(400,'Không thể đánh giá game của chính mình.');
    run('INSERT INTO ratings(post_id,user_id,value,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',post.id,uid(res),value,timestamp(),timestamp());
    res.json({post:shape(post,uid(res))});
  }));
  app.delete('/api/posts/:id/rating',authenticated,route((req,res)=>{const post=postRow(String(req.params.id),res.locals.user);run('DELETE FROM ratings WHERE post_id=? AND user_id=?',post.id,uid(res));res.json({post:shape(post,uid(res))});}));
  app.post('/api/profiles/:id/follow',authenticated,route((req,res)=>{
    const author=one('SELECT id,name FROM users WHERE id=?',req.params.id);
    if(!author)throw new HttpError(404,'Tài khoản không tồn tại.');
    if(author.id===uid(res))throw new HttpError(400,'Không thể theo dõi chính mình.');
    let following=false;
    transaction(()=>{
      if(one('SELECT 1 FROM follows WHERE follower_id=? AND author_id=?',uid(res),author.id))run('DELETE FROM follows WHERE follower_id=? AND author_id=?',uid(res),author.id);
      else{run('INSERT INTO follows VALUES(?,?,?)',uid(res),author.id,timestamp());following=true;notify(author.id,'follow',`${res.locals.user.name} bắt đầu theo dõi bạn.`,`/profile/${uid(res)}`);}
    });
    res.json({following,followers:Number(one('SELECT COUNT(*) AS n FROM follows WHERE author_id=?',author.id)!.n)});
  }));
  app.get('/api/profiles/:id/community',route((req,res)=>{
    const author=one('SELECT id,name FROM users WHERE id=?',req.params.id);if(!author)throw new HttpError(404,'Tài khoản không tồn tại.');
    res.json({author,followers:Number(one('SELECT COUNT(*) AS n FROM follows WHERE author_id=?',author.id)!.n),following:Number(one('SELECT COUNT(*) AS n FROM follows WHERE follower_id=?',author.id)!.n),followingAuthor:!!res.locals.user&&!!one('SELECT 1 FROM follows WHERE author_id=? AND follower_id=?',author.id,uid(res)),posts:all("SELECT * FROM posts WHERE author_id=? AND status='published' AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 50",author.id).map(post=>shape(post,res.locals.user?.id))});
  }));

  app.post('/api/reports',authenticated,route((req,res)=>{
    const data=z.object({targetType:z.enum(['post','comment']),targetId:z.string().uuid(),reason:z.string().trim().min(5).max(2000)}).parse(req.body);
    let post:Row;let comment:Row|undefined;
    if(data.targetType==='comment'){comment=one('SELECT * FROM comments WHERE id=? AND hidden_at IS NULL',data.targetId);if(!comment)throw new HttpError(404,'Bình luận không tồn tại.');post=postRow(comment.post_id,res.locals.user);}
    else post=postRow(data.targetId,res.locals.user);
    published(post);
    const column=data.targetType==='post'?'post_id':'comment_id';
    if(one(`SELECT 1 FROM reports WHERE reporter_id=? AND ${column}=? AND status='open'`,uid(res),data.targetId))throw new HttpError(409,'Báo cáo này đang chờ xử lý.');
    const reportId=randomUUID();run('INSERT INTO reports(id,reporter_id,post_id,comment_id,reason,created_at) VALUES(?,?,?,?,?,?)',reportId,uid(res),data.targetType==='post'?post.id:null,comment?.id||null,data.reason,timestamp());
    audit(uid(res),null,'community.report_created',reportId);
    res.status(201).json({report:{id:reportId,status:'open'}});
  }));
  app.get('/api/moderation/reports',authenticated,route((req,res)=>{
    if(!moderator(res.locals.user))throw new HttpError(403,'Cần quyền kiểm duyệt.');
    const {status,page}=z.object({status:z.enum(['open','resolved','dismissed']).default('open'),page:z.coerce.number().int().min(1).max(10000).default(1)}).parse(req.query);
    const reports=all('SELECT r.*,u.name AS reporter_name,p.title AS post_title,c.body AS comment_body FROM reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN posts p ON p.id=r.post_id LEFT JOIN comments c ON c.id=r.comment_id WHERE r.status=? ORDER BY r.created_at,r.id LIMIT 50 OFFSET ?',status,(page-1)*50).map(report=>({id:report.id,targetType:report.post_id?'post':'comment',targetId:report.post_id||report.comment_id,reporter:{id:report.reporter_id,name:report.reporter_name},reason:report.reason,status:report.status,title:report.post_title||null,body:report.comment_body||null,resolution:report.resolution,createdAt:report.created_at}));
    res.json({reports,page,hasMore:reports.length===50});
  }));
  app.post('/api/moderation/reports/:id/resolve',authenticated,route((req,res)=>{
    if(!moderator(res.locals.user))throw new HttpError(403,'Cần quyền kiểm duyệt.');
    const {action,note}=z.object({action:z.enum(['hide','restore','dismiss']),note:z.string().trim().min(1).max(2000)}).parse(req.body);
    const report=one('SELECT * FROM reports WHERE id=?',req.params.id);if(!report)throw new HttpError(404,'Báo cáo không tồn tại.');
    const targetType=report.post_id?'post':'comment',table=report.post_id?'posts':'comments',targetId=report.post_id||report.comment_id;
    const target=one(`SELECT * FROM ${table} WHERE id=?`,targetId);if(!target)throw new HttpError(404,'Nội dung không còn tồn tại.');
    transaction(()=>{
      if(action!=='dismiss')run(`UPDATE ${table} SET hidden_at=?,hidden_reason=? WHERE id=?`,action==='hide'?timestamp():null,action==='hide'?note:'',targetId);
      run('UPDATE reports SET status=?,resolution=?,resolved_at=?,resolved_by=? WHERE id=?',action==='dismiss'?'dismissed':'resolved',note,timestamp(),uid(res),report.id);
      run('INSERT INTO moderation_actions VALUES(?,?,?,?,?,?,?)',randomUUID(),uid(res),targetType,targetId,action,note,timestamp());
      audit(uid(res),null,`moderation.${action}`,`${targetType}:${targetId}`);
      if(action!=='dismiss')notify(target.author_id,'moderation',action==='hide'?'Nội dung của bạn đã được ẩn để kiểm duyệt.':'Nội dung của bạn đã được khôi phục.',`/games/${report.post_id||target.post_id}`);
    });
    res.json({ok:true,action});
  }));

  app.get('/api/posts/:id/releases',route((req,res)=>{const post=postRow(String(req.params.id),res.locals.user);res.json({releases:all('SELECT * FROM game_releases WHERE post_id=? ORDER BY created_at DESC,id',post.id).map(releaseShape)});}));
  app.post('/api/posts/:id/releases',authenticated,route((req,res)=>{
    const post=postRow(String(req.params.id),res.locals.user);editPost(post,res);
    const data=z.object({version:z.string().trim().min(1).max(40).regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/),changelog:z.string().trim().min(1).max(10000),mediaId:z.string().uuid().nullable().optional()}).parse(req.body);
    if(data.mediaId&&!one('SELECT 1 FROM media WHERE id=? AND post_id=? AND user_id=?',data.mediaId,post.id,post.author_id))throw new HttpError(400,'Tệp tải xuống phải thuộc game này.');
    if(one('SELECT 1 FROM game_releases WHERE post_id=? AND version=?',post.id,data.version))throw new HttpError(409,'Phiên bản đã tồn tại.');
    const releaseId=randomUUID();transaction(()=>{run('INSERT INTO game_releases VALUES(?,?,?,?,?,?,?)',releaseId,post.id,data.version,data.changelog,data.mediaId||null,uid(res),timestamp());run('UPDATE posts SET updated_at=?,version=version+1 WHERE id=?',timestamp(),post.id);audit(uid(res),null,'community.release_created',releaseId);});
    res.status(201).json({release:releaseShape(one('SELECT * FROM game_releases WHERE id=?',releaseId)!)});
  }));
}
