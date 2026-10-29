import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { HttpError, type ModuleContext, type Row } from './context.js';
import { GitHubClient, safeBranch, safeRepositoryPath } from './github.js';
import { validateSourceFiles, type SourceFiles } from './build-runner.js';
import { projectPermissions } from './projects.js';

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 100;
const MAX_HISTORY_BYTES = 10 * MAX_BYTES;
const sha = /^[a-f0-9]{40}$/i;
const supported = /\.(?:html|css|js|mjs|cjs|json|txt|md)$/i;
function privatePath(path: string) { return path.split('/').some(part => part.startsWith('.') || ['credentials.json','service-account.json','id_rsa','id_ed25519'].includes(part.toLowerCase()) || /\.(?:pem|key|p12|pfx)$/i.test(part)); }
function requireActor(ctx: ModuleContext, projectId: string, userId: string) {
  const project = ctx.one('SELECT p.*,m.role FROM projects p JOIN project_members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=? AND p.deleted_at IS NULL', userId, projectId);
  if (!project || !projectPermissions(project.role, !!project.locked).viewSource || (project.locked && project.role !== 'owner')) throw new HttpError(403, 'Không còn quyền tạo snapshot mã nguồn của dự án.');
}
export function sourceHash(files: SourceFiles) {
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
}
export function validateWorkspaceFiles(files: unknown): asserts files is SourceFiles {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new HttpError(400, 'Workspace cần danh sách tệp văn bản.');
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw new HttpError(400, 'Workspace cần 1–100 tệp văn bản.');
  let bytes = 0;
  for (const [path, content] of entries) {
    if (!safeRepositoryPath(path) || !supported.test(path) || path.includes('node_modules') || privatePath(path) || typeof content !== 'string' || content.includes('\0')) throw new HttpError(400, 'Đường dẫn, cấu hình riêng hoặc nội dung workspace không được hỗ trợ.');
    bytes += Buffer.byteLength(content);
  }
  if (bytes > MAX_BYTES) throw new HttpError(413, 'Snapshot workspace vượt quá 1 MiB.');
}
export const workspaceShape = (row: Row) => ({id: row.id, projectId: row.project_id, source: row.source, base: row.base_branch, baseCommit: row.base_commit, manifestHash: row.manifest_hash, fileCount: row.file_count, totalBytes: row.total_bytes, staticSupported: !!row.static_supported, excludedPaths: JSON.parse(row.excluded_paths_json || '[]'), createdAt: row.created_at});

export async function persistWorkspace(ctx: ModuleContext, input: {projectId: string; userId: string; source: 'github'|'local'; files: SourceFiles; owner?: string; repository?: string; base?: string; baseCommit?: string; excludedPaths?: string[]}) {
  requireActor(ctx, input.projectId, input.userId);
  validateWorkspaceFiles(input.files);
  const serialized = JSON.stringify(input.files);
  const stored = Number(ctx.one('SELECT COALESCE(SUM(total_bytes),0) AS n FROM source_workspaces WHERE project_id=?', input.projectId)?.n || 0);
  if (stored + Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) throw new HttpError(413, 'Lịch sử workspace vượt hạn mức 10 MiB của dự án.');
  const id = randomUUID(), root = join(ctx.dataDir, 'workspaces', id);
  let staticSupported = true;
  try { validateSourceFiles(input.files); } catch { staticSupported = false; }
  try {
    await mkdir(root, {recursive: true, mode: 0o700});
    for (const [path, content] of Object.entries(input.files)) {
      const target = join(root, 'source', path);
      await mkdir(dirname(target), {recursive: true, mode: 0o700});
      await writeFile(target, content, {flag: 'wx', mode: 0o600});
    }
    const hash = sourceHash(input.files);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({id, source: input.source, baseCommit: input.baseCommit || null, manifestHash: hash, files: Object.keys(input.files).sort(), excludedPaths: input.excludedPaths || []}), {flag: 'wx', mode: 0o600});
    ctx.transaction(() => {
      requireActor(ctx, input.projectId, input.userId);
      const current = Number(ctx.one('SELECT COALESCE(SUM(total_bytes),0) AS n FROM source_workspaces WHERE project_id=?', input.projectId)?.n || 0);
      if (current + Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) throw new HttpError(413, 'Lịch sử workspace vượt hạn mức 10 MiB.');
      ctx.run('INSERT INTO source_workspaces(id,project_id,created_by,source,repository_owner,repository_name,base_branch,base_commit,files_json,manifest_hash,file_count,total_bytes,static_supported,excluded_paths_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, input.projectId, input.userId, input.source, input.owner || null, input.repository || null, input.base || null, input.baseCommit || null, serialized, hash, Object.keys(input.files).length, Buffer.byteLength(serialized), staticSupported ? 1 : 0, JSON.stringify(input.excludedPaths || []), new Date().toISOString());
      ctx.audit(input.userId, input.projectId, 'workspace.created', id);
    });
    return ctx.one('SELECT * FROM source_workspaces WHERE id=?', id)!;
  } catch (error) { await rm(root, {recursive: true, force: true}); throw error; }
}

/** Fetch only immutable, verified text blobs. No Git credentials or host checkout is exposed. */
export async function captureGitHubWorkspace(ctx: ModuleContext, github: GitHubClient, link: Row, connection: Row, base: string, userId: string) {
  if (!safeBranch(base)) throw new HttpError(400, 'Nhánh snapshot không hợp lệ.');
  const {token} = await github.repository(connection, link.owner, link.repository);
  const prefix = `/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}`;
  const ref = await github.request(prefix + '/git/ref/heads/' + encodeURIComponent(base), token);
  const commitSha = ref?.object?.sha;
  if (typeof commitSha !== 'string' || !sha.test(commitSha)) throw new HttpError(502, 'GitHub trả commit SHA không hợp lệ.');
  const commit = await github.request(prefix + '/git/commits/' + commitSha, token);
  if (!sha.test(commit?.tree?.sha || '')) throw new HttpError(502, 'GitHub trả tree SHA không hợp lệ.');
  const tree = await github.request(prefix + '/git/trees/' + commit.tree.sha + '?recursive=1', token);
  if (!Array.isArray(tree?.tree) || tree.truncated || tree.tree.length > 1000) throw new HttpError(413, 'Cây repository bị cắt hoặc vượt giới hạn snapshot.');
  if (tree.tree.some((entry: any) => entry.mode === '120000' || entry.mode === '160000' || entry.type === 'commit')) throw new HttpError(400, 'Snapshot này có symlink hoặc submodule; chưa hỗ trợ kiểm thử an toàn.');
  const entries = tree.tree.filter((entry: any) => entry.type === 'blob' && typeof entry.path === 'string' && supported.test(entry.path) && !privatePath(entry.path) && !entry.path.includes('node_modules'));
  const selected = new Set(entries.map((entry: any) => entry.path));
  const excludedPaths = tree.tree.filter((entry: any) => entry.type === 'blob' && typeof entry.path === 'string' && !selected.has(entry.path)).map((entry: any) => entry.path);
  if (!entries.length || entries.length > MAX_FILES) throw new HttpError(413, 'Repository không có snapshot văn bản phù hợp hoặc vượt 100 tệp.');
  const files: SourceFiles = {};
  let total = 0;
  for (const entry of entries) {
    if (!safeRepositoryPath(entry.path) || !['100644','100755'].includes(entry.mode) || !sha.test(entry.sha || '') || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new HttpError(400, 'Snapshot từ chối symlink, submodule hoặc đường dẫn/blob không hợp lệ.');
    total += entry.size;
    if (total > MAX_BYTES) throw new HttpError(413, 'Snapshot repository vượt quá 1 MiB.');
    const blob = await github.request(prefix + '/git/blobs/' + entry.sha, token);
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)) throw new HttpError(502, 'GitHub trả blob không hợp lệ.');
    const bytes = Buffer.from(blob.content.replace(/[\r\n]/g, ''), 'base64');
    if (bytes.length !== entry.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new HttpError(502, 'Checksum Git blob không khớp; không dùng snapshot này.');
    try { files[entry.path] = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
    catch { throw new HttpError(400, 'Snapshot chỉ hỗ trợ mã nguồn UTF-8.'); }
  }
  return persistWorkspace(ctx, {projectId: link.project_id, userId, source: 'github', files, owner: link.owner, repository: link.repository, base, baseCommit: commitSha, excludedPaths});
}

export function mergedProposalFiles(workspace: Row, changes: Array<{path: string; content: string}>) {
  const files = {...JSON.parse(workspace.files_json)} as SourceFiles;
  const paths = new Set<string>();
  for (const change of changes) {
    if (paths.has(change.path)) throw new HttpError(400, 'Đề xuất có đường dẫn lặp.');
    paths.add(change.path); files[change.path] = change.content;
  }
  validateWorkspaceFiles(files);
  validateSourceFiles(files);
  return files;
}
