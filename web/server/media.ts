import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { z } from 'zod';
import type { Response, NextFunction, Request } from 'express';
import type { ModuleContext, Row } from './context.js';
import { HttpError } from './context.js';

const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const OWNER_QUOTA = 100 * 1024 * 1024;
const FILE_BYTES = 1024 * 1024;
const upload = multer({storage: multer.memoryStorage(), preservePath: true, limits: {fileSize: MAX_BYTES, files: 1, fields: 2, fieldSize: 1000, parts: 3}}).single('file');

function validArchive(input: Buffer) {
  // Validate the central directory without extracting user archives or allocating their expanded contents.
  let end = -1;
  for (let offset=input.length-22;offset>=Math.max(0,input.length-65557);offset--) {
    if(input.readUInt32LE(offset)===0x06054b50 && offset+22+input.readUInt16LE(offset+20)===input.length){end=offset;break;}
  }
  if(end<0 || input.readUInt16LE(end+4)!==0 || input.readUInt16LE(end+6)!==0)return false;
  const entries=input.readUInt16LE(end+10),size=input.readUInt32LE(end+12),start=input.readUInt32LE(end+16);
  if(entries<1 || entries>2000 || input.readUInt16LE(end+8)!==entries || start+size!==end)return false;
  let offset=start,expanded=0;
  for(let index=0;index<entries;index++) {
    if(offset+46>end || input.readUInt32LE(offset)!==0x02014b50)return false;
    const flags=input.readUInt16LE(offset+8),method=input.readUInt16LE(offset+10),compressed=input.readUInt32LE(offset+20),uncompressed=input.readUInt32LE(offset+24),nameLength=input.readUInt16LE(offset+28),extra=input.readUInt16LE(offset+30),comment=input.readUInt16LE(offset+32),local=input.readUInt32LE(offset+42);
    const next=offset+46+nameLength+extra+comment;
    if(next>end || !nameLength || flags&1 || ![0,8].includes(method) || local+30>start || input.readUInt32LE(local)!==0x04034b50)return false;
    const filename=input.subarray(offset+46,offset+46+nameLength).toString('utf8');
    if(filename.startsWith('/') || /[\\\x00-\x1f]/.test(filename) || /^[A-Za-z]:/.test(filename) || filename.split('/').includes('..'))return false;
    const unixType=(input.readUInt32LE(offset+38)>>>16)&0xf000;
    if(unixType===0xa000)return false;
    const localName=input.readUInt16LE(local+26),localExtra=input.readUInt16LE(local+28);
    if(localName!==nameLength || local+30+localName+localExtra+compressed>start || input.readUInt16LE(local+6)!==flags || input.readUInt16LE(local+8)!==method || !input.subarray(local+30,local+30+localName).equals(input.subarray(offset+46,offset+46+nameLength)))return false;
    expanded+=uncompressed;
    if(expanded>OWNER_QUOTA || (compressed===0 && uncompressed>0) || uncompressed>Math.max(1,compressed)*1000)return false;
    offset=next;
  }
  return offset===end;
}

export const mediaShape = (row: Row) => ({id: row.id, userId: row.user_id, postId: row.post_id, purpose: row.purpose, kind: row.kind, mime: row.mime, size: row.size, name: row.original_name, url: `/api/media/${row.id}/content`, createdAt: row.created_at});

export function canReadMedia(ctx: ModuleContext, row: Row, user?: Row) {
  if (row.user_id === user?.id) return true;
  if (row.purpose === 'avatar' && row.kind === 'image') return true;
  return !!row.post_id && !!ctx.one("SELECT 1 FROM posts WHERE id=? AND status='published' AND hidden_at IS NULL", row.post_id);
}

export async function storeMedia(ctx: ModuleContext, file: Express.Multer.File, options: {purpose: 'avatar'|'post'|'attachment'; postId?: string}, userId: string) {
  if (!file?.buffer.length) throw new HttpError(400, 'Hãy chọn một tệp hợp lệ.');
  if (file.buffer.length > MAX_BYTES) throw new HttpError(413, 'Tệp vượt quá 25 MiB.');
  if (!file.originalname || file.originalname.length > 150 || /[\\/\x00-\x1f\x7f]/.test(file.originalname) || file.originalname === '.' || file.originalname === '..') throw new HttpError(400, 'Tên tệp không hợp lệ.');
  if (options.purpose !== 'avatar' && !options.postId) throw new HttpError(400, 'Tệp game phải thuộc một bài đăng.');
  if (options.purpose === 'avatar' && options.postId) throw new HttpError(400, 'Avatar không gắn vào bài đăng.');
  if (options.postId) {
    const post = ctx.one('SELECT author_id FROM posts WHERE id=?', options.postId);
    if (!post) throw new HttpError(404, 'Bài đăng không tồn tại.');
    // Even administrators upload files under their own posts; this prevents surprise content replacement.
    if (post.author_id !== userId) throw new HttpError(403, 'Chỉ tác giả được tải tệp cho bài đăng.');
  }
  const used = Number(ctx.one('SELECT COALESCE(SUM(size),0) AS bytes FROM media WHERE user_id=?', userId)?.bytes || 0);
  if (used >= OWNER_QUOTA) throw new HttpError(413, 'Đã đạt giới hạn lưu trữ 100 MiB cho tài khoản.');
  const input = file.buffer;
  const extension = extname(file.originalname).toLowerCase();
  let output: Buffer;
  let kind: 'image'|'video'|'file';
  let mime: string;
  let suffix: string;
  if (['.jpg','.jpeg','.png','.webp'].includes(extension)) {
    if (input.length > IMAGE_BYTES) throw new HttpError(413, 'Ảnh vượt quá 5 MiB.');
    try {
      const image = sharp(input, {limitInputPixels: 25_000_000, failOn: 'error', animated: false});
      const meta = await image.metadata();
      if (!['jpeg','png','webp'].includes(meta.format || '') || !meta.width || !meta.height || meta.width > 10000 || meta.height > 10000 || (meta.pages || 1) > 1) throw new Error('Unsupported image');
      output = await image.rotate().webp({quality: 85}).toBuffer();
    } catch { throw new HttpError(400, 'Ảnh JPEG/PNG/WebP không hợp lệ hoặc vượt giới hạn kích thước.'); }
    kind = 'image'; mime = 'image/webp'; suffix = '.webp';
  } else if (extension === '.mp4' && input.length >= 12 && input.subarray(4,8).toString('ascii') === 'ftyp') {
    output = input; kind = 'video'; mime = 'video/mp4'; suffix = '.mp4';
  } else if (extension === '.webm' && input.length >= 4 && input.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) {
    output = input; kind = 'video'; mime = 'video/webm'; suffix = '.webm';
  } else if (['.txt','.json'].includes(extension) && input.length <= FILE_BYTES) {
    let decoded: string;
    try {decoded = new TextDecoder('utf-8', {fatal: true}).decode(input);} catch {throw new HttpError(400, 'Tệp văn bản phải dùng UTF-8 hợp lệ.');}
    if (decoded.includes('\u0000')) throw new HttpError(400, 'Tệp văn bản có dữ liệu nhị phân.');
    if (extension === '.json') {try {JSON.parse(decoded);} catch {throw new HttpError(400, 'Tệp JSON không hợp lệ.');}}
    output = input; kind = 'file'; mime = extension === '.json' ? 'application/json' : 'text/plain; charset=utf-8'; suffix = extension;
  } else if (extension === '.zip' && input.length >= 22 && validArchive(input)) {
    output = input; kind = 'file'; mime = 'application/zip'; suffix = '.zip';
  } else { throw new HttpError(400, 'Chỉ hỗ trợ ảnh JPEG/PNG/WebP, MP4/WebM, TXT/JSON và ZIP hợp lệ.'); }
  if (options.purpose === 'avatar' && kind !== 'image') throw new HttpError(400, 'Avatar phải là ảnh.');
  if (used + output.length > OWNER_QUOTA) throw new HttpError(413, 'Tệp vượt hạn mức lưu trữ 100 MiB.');
  const mediaId = randomUUID();
  const storageName = mediaId + suffix;
  const directory = join(ctx.dataDir, 'media');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await writeFile(join(directory, storageName), output, {flag: 'wx', mode: 0o600});
  try {
    // Recheck quota after asynchronous image work, then reserve the row synchronously.
    ctx.transaction(() => {
      const latest = Number(ctx.one('SELECT COALESCE(SUM(size),0) AS bytes FROM media WHERE user_id=?', userId)?.bytes || 0);
      if (latest + output.length > OWNER_QUOTA) throw new HttpError(413, 'Tệp vượt hạn mức lưu trữ 100 MiB.');
      ctx.run('INSERT INTO media(id,user_id,post_id,purpose,kind,mime,size,storage_name,original_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', mediaId, userId, options.postId || null, options.purpose, kind, mime, output.length, storageName, file.originalname, new Date().toISOString());
      ctx.audit(userId, null, 'media.uploaded', mediaId);
    });
  } catch (error) {await unlink(join(directory, storageName)).catch(() => {}); throw error;}
  return mediaShape(ctx.one('SELECT * FROM media WHERE id=?', mediaId)!);
}

export function registerMedia(ctx: ModuleContext) {
  const {app, authenticated, route, uid, one, all, run, dataDir} = ctx;
  let activeUploads=0;
  const attempts=new Map<string,{count:number;reset:number}>();
  app.post('/api/media', authenticated, (req: Request, res: Response, next: NextFunction) => {
    const owner=uid(res),now=Date.now();let count=attempts.get(owner);
    if(!count || count.reset<now){count={count:0,reset:now+60000};attempts.set(owner,count);}
    if(++count.count>10)return next(new HttpError(429,'Chỉ tải tối đa 10 tệp mỗi phút.'));
    if(activeUploads>=4)return next(new HttpError(503,'Máy chủ đang xử lý nhiều tệp. Vui lòng thử lại.'));
    activeUploads++;
    let released=false;
    const release=()=>{if(!released){released=true;activeUploads--;}};
    res.once('finish',release);res.once('close',release);
    if(attempts.size>1000)for(const [key,entry] of attempts)if(entry.reset<now)attempts.delete(key);
    upload(req,res,error => {
      if (error instanceof multer.MulterError) return next(new HttpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.code === 'LIMIT_FILE_SIZE' ? 'Tệp vượt quá 25 MiB.' : 'Multipart upload không hợp lệ.'));
      if (error) return next(new HttpError(400, 'Upload không hợp lệ.'));
      const parsed = z.object({purpose:z.enum(['avatar','post','attachment']),postId:z.string().uuid().optional()}).safeParse(req.body);
      if (!parsed.success) return next(new HttpError(400,'Thiếu loại tệp hoặc mã bài đăng hợp lệ.'));
      if (!req.file) return next(new HttpError(400,'Hãy chọn một tệp.'));
      void storeMedia(ctx,req.file,parsed.data,uid(res)).then(media => res.status(201).json({media})).catch(next);
    });
  });
  app.get('/api/media/:id/content', route((req,res) => {
    const row = one('SELECT * FROM media WHERE id=?',req.params.id);
    if (!row || !canReadMedia(ctx,row,res.locals.user)) throw new HttpError(404,'Tệp không tồn tại hoặc không có quyền truy cập.');
    if (!/^[a-f0-9-]{36}\.(webp|mp4|webm|txt|json|zip)$/.test(row.storage_name)) throw new HttpError(404,'Tệp không tồn tại.');
    res.setHeader('Content-Type',row.mime);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    res.setHeader('Cache-Control',row.purpose === 'avatar' ? 'public, max-age=3600' : 'private, no-store');
    // Attachments never render HTML/JS in the trusted app origin.
    res.setHeader('Content-Disposition',`${row.kind === 'file' ? 'attachment' : 'inline'}; filename="${row.storage_name}"`);
    res.sendFile(row.storage_name,{root:join(dataDir,'media')},error=>{if(error&&!res.headersSent)res.status(404).json({error:'Tệp không còn trên ổ đĩa.'});});
  }));
  app.get('/api/media',authenticated,route((_req,res)=>res.json({media:all('SELECT * FROM media WHERE user_id=? ORDER BY created_at DESC LIMIT 100',uid(res)).map(mediaShape),quotaBytes:OWNER_QUOTA})));
  app.delete('/api/media/:id',authenticated,route(async(req,res)=>{
    const row=one('SELECT * FROM media WHERE id=?',req.params.id);
    if(!row||row.user_id!==uid(res))throw new HttpError(404,'Tệp không tồn tại.');
    // Retained release downloads must be unlinked from their release before deleting the file.
    if(one('SELECT 1 FROM game_releases WHERE media_id=?',row.id))throw new HttpError(409,'Tệp đang được dùng trong một phiên bản game.');
    run('DELETE FROM media WHERE id=?',row.id);
    await unlink(join(dataDir,'media',row.storage_name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    ctx.audit(uid(res),null,'media.deleted',row.id);
    res.json({ok:true});
  }));
}
