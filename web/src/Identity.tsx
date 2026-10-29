import React, { useEffect, useState } from 'react';
import { ActionForm, ErrorMessage, Notice, request, readableDate } from './phase-ui';

export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [message, setMessage] = useState('');
  return <div className="phase-stack"><h3>Khôi phục mật khẩu</h3><p>Liên kết khôi phục có thời hạn và chỉ dùng một lần. Mật khẩu không được gửi qua email.</p><ActionForm submit="Gửi liên kết khôi phục" onSubmit={async data => { const result = await request('/auth/password/forgot', 'POST', { email: data.get('email') }); setMessage(result.message); }}><label>Email tài khoản<input name="email" type="email" required autoComplete="email"/></label></ActionForm>{message && <Notice>{message}</Notice>}<button className="text-button" onClick={onBack}>Quay lại đăng nhập</button></div>;
}

export function EmailAction({ user, onLoginUser, onClose, onUpdated }: { user:any; onLoginUser:(user:any)=>void; onClose: () => void; onUpdated: () => void }) {
  const [action] = useState(() => {
    const match = location.hash.match(/^#auth\/(verify-email|reset-password)\?(.+)$/);
    return match ? { kind: match[1], token: new URLSearchParams(match[2]).get('token') || '' } : null;
  });
  const [message, setMessage] = useState(''), [done, setDone] = useState(false);
  if (!action) return null;
  return <section className="email-action panel" role="dialog" aria-modal="true" aria-label={action.kind === 'verify-email' ? 'Xác minh email' : 'Đặt lại mật khẩu'}><h2>{action.kind === 'verify-email' ? 'Xác minh email của bạn' : 'Đặt mật khẩu mới'}</h2>{action.kind==='verify-email'&&!user&&!done?<><Notice>Đăng nhập đúng tài khoản nhận liên kết để xác minh quyền sở hữu email.</Notice><ActionForm submit="Đăng nhập để xác minh" onSubmit={async data=>{const r=await request('/auth/login','POST',{email:data.get('email'),password:data.get('password')});onLoginUser(r.user)}}><label>Email nhận liên kết<input name="email" type="email" required autoComplete="email"/></label><label>Mật khẩu tài khoản<input name="password" type="password" required autoComplete="current-password"/></label></ActionForm></>:done ? <><Notice>{message}</Notice><button className="button button-primary" onClick={onClose}>Tiếp tục</button></> : <ActionForm submit={action.kind === 'verify-email' ? 'Xác minh email' : 'Đặt lại mật khẩu'} onSubmit={async data => {
    const result = await request(action.kind === 'verify-email' ? '/auth/verification/confirm' : '/auth/password/reset', 'POST', { token: action.token, ...(action.kind === 'reset-password' ? { password: data.get('password') } : {}) });
    history.replaceState(null,'',location.pathname+location.search+'#settings'); setMessage(result.message); setDone(true); onUpdated();
  }}>{action.kind === 'reset-password' ? <label>Mật khẩu mới<input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password"/></label> : <p>Tiếp tục để xác nhận bạn sở hữu địa chỉ email nhận liên kết này.</p>}</ActionForm>}</section>;
}

export function IdentitySettings({ user, onUpdated }: { user: any; onUpdated: () => void }) {
  const [status, setStatus] = useState<any>(null), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null), [uploading, setUploading] = useState(false);
  useEffect(() => { request('/auth/email/status').then(setStatus).catch(e => setError(e.message)); }, [user.id, user.emailVerified]);
  return <section className="panel identity-settings"><h2>Danh tính & hồ sơ công khai</h2><p><a href={'#profile/' + user.id}>Xem hồ sơ công khai của bạn ↗</a></p><span className={'tag ' + (status?.emailVerified ? 'tag-green' : 'tag-amber')}>{status?.emailVerified ? 'Email đã xác minh' : 'Email chưa xác minh'}</span>
    {!status?.emailVerified && <><p className="hint">Xác minh email để bảo vệ lời mời cộng tác. {status?.mode === 'file' ? 'Chế độ thư thử nghiệm cục bộ: người vận hành lấy thư trong hộp thư riêng của môi trường.' : status?.deliveryConfigured ? 'Liên kết được gửi qua dịch vụ email đã cấu hình.' : 'Người vận hành cần cấu hình dịch vụ email để gửi liên kết.'}</p><button className="button button-outline" disabled={!status?.deliveryConfigured} onClick={async () => { try { const r = await request('/auth/verification/request', 'POST', {}); setMessage(r.message); } catch (e) { setError((e as Error).message); } }}>Gửi lại email xác minh</button></>}
    {message && <Notice>{message}</Notice>}<ErrorMessage error={error}/>
    <ActionForm key={user.identityVersion || 0} submit="Lưu hồ sơ công khai" onSubmit={async data => { await request('/identity/profile', 'PATCH', { bio: data.get('bio'), version: user.identityVersion, ...(avatar ? { avatarMediaId: avatar } : {}) }); setMessage('Đã lưu hồ sơ công khai.'); onUpdated(); }}>
      <label>Giới thiệu bản thân<textarea name="bio" defaultValue={user.bio || ''} maxLength={2000} rows={4}/></label>
      {user.avatarUrl && <img className="profile-avatar-image" src={user.avatarUrl} alt="Ảnh đại diện hiện tại"/>}
      <label>Ảnh đại diện<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setUploading(true); setError(''); try { const form = new FormData(); form.set('purpose', 'avatar'); form.set('file', file); const r = await request('/media', 'POST', form); setAvatar(r.media.id); setMessage('Ảnh đã tải lên. Nhấn lưu hồ sơ để áp dụng.'); } catch (e) { setError((e as Error).message); } finally { setUploading(false); } }}/></label>
      {uploading && <p role="status">Đang kiểm tra và tải ảnh…</p>}
    </ActionForm>
    <details><summary>Thay đổi địa chỉ email</summary><ActionForm submit="Thay đổi email" onSubmit={async data => { await request('/identity/email', 'POST', { email: data.get('email'), password: data.get('password'), version: user.identityVersion }); setMessage('Email đã thay đổi. Hãy xác minh địa chỉ mới.'); onUpdated(); }}><label>Email mới<input name="email" type="email" required/></label><label>Mật khẩu hiện tại<input name="password" type="password" autoComplete="current-password" required/></label></ActionForm></details>
  </section>;
}

export function PublicProfile({ id }: { id: string }) {
  const [profile, setProfile] = useState<any>(null), [error, setError] = useState('');
  useEffect(() => { request('/profiles/' + encodeURIComponent(id)).then(r => setProfile(r.profile)).catch(e => setError(e.message)); }, [id]);
  return <section className="panel public-profile"><ErrorMessage error={error}/>{profile ? <>{profile.avatarUrl && <img className="profile-avatar-image" src={profile.avatarUrl} alt={'Ảnh đại diện ' + profile.name}/>}<p className="eyebrow">NHÀ SÁNG TẠO TRONG LÀNG</p><h1>{profile.name}</h1><p className="preserve-lines">{profile.bio || 'Người sáng tạo này chưa viết lời giới thiệu.'}</p><div className="project-summary"><span>{profile.postCount} bài viết</span><span>{profile.followers} người theo dõi</span><span>{profile.following} đang theo dõi</span></div><p className="hint">Tham gia {readableDate(profile.createdAt)}</p><a className="text-button" href="#home">Về quảng trường</a></> : !error && <p>Đang mở hồ sơ…</p>}</section>;
}

export function AdminRoles() {
  const [users, setUsers] = useState<any[]>([]), [roles, setRoles] = useState<any[]>([]), [error, setError] = useState('');
  async function load() { try { const [a, b] = await Promise.all([request('/admin/users'), request('/admin/roles')]); setUsers(a.users); setRoles(b.roles); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void load(); }, []);
  return <section className="panel"><h2>Quản lý vai trò hệ thống</h2><p className="hint">Vai trò hệ thống không tự cấp quyền vào dự án riêng tư.</p><ErrorMessage error={error}/>{users.map(user => <details key={user.id}><summary>{user.name} · {user.email} · {user.roles.join(', ')}</summary><ActionForm submit="Lưu quyền" onSubmit={async data => { await request('/admin/users/' + user.id + '/roles', 'PATCH', { roles: data.getAll('roles'), version: user.identityVersion }); await load(); }}>{roles.map(role => <label key={role.role} className="check-row"><input type="checkbox" name="roles" value={role.role} defaultChecked={user.roles.includes(role.role)}/><span>{role.role}<small>{role.permissions.join(', ')}</small></span></label>)}</ActionForm></details>)}</section>;
}
