import React from 'react';
import { ArrowUpRight } from 'lucide-react';

type Place = 'home' | 'studio' | 'projects' | 'settings';

function Tree({x,y,scale=1,tone=0}:{x:number;y:number;scale?:number;tone?:number}) {
  const colors = tone ? ['#4b7452','#638759','#799362'] : ['#2f6049','#4c7956','#658d63'];
  return <g transform={`translate(${x} ${y}) scale(${scale})`}><ellipse cx="0" cy="48" rx="27" ry="9" fill="#476b48" opacity=".22"/><path d="M-5 15h12v42h-18l7-9z" fill="#7e543b"/><path d="M-1 16h7v32H1z" fill="#a57448"/><path d="M-27 7h8V-6h9v-13h21v9h14V5h9v28H22v10h-45V32h-13V15h9z" fill={colors[0]}/><path d="M-22 3h9v-13H8v8h15v20H12v9h-31V16h-10V8h7z" fill={colors[1]}/><path d="M-11-7H7v8h12v9H5v7H-15V9h-7V3h11z" fill={colors[2]}/><path d="M-29 22h10v9h11v7h-15v-8h-6z" fill="#254c3a" opacity=".5"/></g>;
}

function Cottage({x,y,scale=1,color='#b96549',type='home'}:{x:number;y:number;scale?:number;color?:string;type?:string}) {
 return <g transform={`translate(${x} ${y}) scale(${scale})`}>
  <ellipse cx="0" cy="57" rx="65" ry="13" fill="#4d6b47" opacity=".25"/>
  <path d="M-52-10H49v62H-52z" fill="#eac892"/>
  <path d="M-52 34H49v18H-52z" fill="#cfa678"/>
  <path d="M-55-12 0-63 55-12v9H-55z" fill="#87483c"/>
  <path d="M-61-12-8-69H7l57 57H49L0-53-45-5h-16z" fill={color}/>
  <path d="M-42-27h32v4h-32m16-19H9v4h-35m27-11h13v4H1m8 23h31v4H9m16 12h24v4H25" stroke="#d58b60" strokeWidth="3" opacity=".7"/>
  <path d="M-55-5h108v7H-55zM-51 24H49v6H-51zM-47 0h7v52h-7zm85 0h7v52h-7zM-5-48h8v49h-8z" fill="#835b44"/>
  <path d="M-40 23-2 1 38 24M-40 2l37 22L39 2" stroke="#976c4e" strokeWidth="4"/>
  <path d="M-13 52V19h26v33" fill="#6e4d3d"/><path d="M-9 21H8v31H-9z" fill="#9f744c"/><path d="M-6 25h3v20h-3" fill="#b98e5e"/><rect x="5" y="37" width="3" height="3" fill="#edc26f"/>
  <g fill="#fff0b4" stroke="#845e47" strokeWidth="4"><path d="M-36 8h16v17h-16zM20 8h16v17H20z"/></g>
  <path d="M-28 10v14m-7-7h14m7 0h14m-7-7v14" stroke="#a77c52" strokeWidth="2"/>
  <path d="M-18 53h37v7h-37m-5 0h47v5h-47" fill="#b69870"/>
  <rect x="29" y="-57" width="11" height="28" fill="#8e674f"/><rect x="26" y="-60" width="17" height="7" fill="#ae8060"/>
  <g className="chimney-smoke" fill="#fff6df" opacity=".5"><rect x="31" y="-72" width="10" height="8"/><rect x="35" y="-84" width="12" height="9"/><rect x="31" y="-95" width="9" height="7"/></g>
  {type==='studio'&&<><path d="M-28 42v-8h-20v8z" fill="#a8b882"/><path d="m-45 35 4-9 5 8 4-12 3 14" fill="#557b47"/><path d="m47 13 10 7-10 7-10-7z" fill="#f3cb73"/><path d="M48 26v16h-3V26" fill="#926944"/></>}
  {type==='home'&&<><path d="M-70 40h20v10h-20" fill="#9c7850"/><path d="M-67 36h16v7h-16" fill="#619154"/><path d="M-62 33h5v5h-5" fill="#ebba75"/></>}
 </g>;
}

function Tower({x,y}:{x:number;y:number}) {
 return <g transform={`translate(${x} ${y})`}><ellipse cx="0" cy="63" rx="43" ry="11" fill="#4d6b47" opacity=".25"/><path d="M-31-51h62V60h-62z" fill="#d5c59f"/><path d="M20-51h11V60H20" fill="#b4a383"/><path d="M-38-49-9-88H10l28 39v8H-38z" fill="#56767a"/><path d="M-37-48H36v8h-73z" fill="#3f5e61"/><path d="M-23-61h42m-31-14h19" stroke="#7d9991" strokeWidth="4"/><path d="M-32-8h64v7h-64M-32 29h64v7h-64" fill="#ad9676"/><path d="M-8-30H8v17H-8zm0 37H8v17H-8z" fill="#6a775e"/><path d="M-7-29H0v14h-7m1 23H0v14h-6" fill="#dbe2ba"/><path d="M-11 60V42h22v18" fill="#8c7657"/><path d="M-38 60h76v6h-76" fill="#a89170"/><path d="M0-87v-24h3v24" fill="#8c7657"/><path d="M3-111h22v13H3z" fill="#d89e60"/><path d="M-26-39h9v6h-9m37 13h13v5H11m-37 28h10v5h-10m35 34h12v6H9" fill="#baa788"/></g>;
}

function Person({x,y,color='#9c694e'}:{x:number;y:number;color?:string}) {
 return <g className="village-person" transform={`translate(${x} ${y})`}><ellipse cx="0" cy="18" rx="9" ry="4" fill="#557045" opacity=".25"/><path d="M-5 9h4v10h-4m6-10h4v10H1" fill="#554b3c"/><path d="M-7-1H7v12H-7" fill={color}/><path d="M-5-11H5V0H-5" fill="#efc18c"/><path d="M-7-13H7v5H-7m-7-4h27v4h-27" fill="#73563c"/><path d="M-10 0h3v8h-3m17-8h3v8H7" fill="#efc18c"/><path d="M2-6h2v2H2" fill="#544639"/></g>;
}

export default function World({onNavigate}:{onNavigate:(place:Place)=>void}) {
 return <div className="village-wrap">
  <svg className="village" viewBox="0 0 1000 470" role="img" aria-label="Ngôi làng Pixel: quảng trường cộng đồng, xưởng AI, tháp dự án và nhà cài đặt. Dùng các nút công trình để điều hướng.">
   <defs><pattern id="grass" width="50" height="42" patternUnits="userSpaceOnUse"><rect width="50" height="42" fill="#a7ba7b"/><path d="M8 15h3v3H8m30 15h3v3h-3M25 3h3v3h-3" fill="#94ab70"/><path d="M14 31v-3m-2 2h4M43 9v-3m-2 2h4" stroke="#879f64" strokeWidth="2" opacity=".65"/></pattern><pattern id="sand" width="35" height="32" patternUnits="userSpaceOnUse"><rect width="35" height="32" fill="#e8cea0"/><path d="M5 8h3v2H5m18 16h4v2h-4" fill="#d9bd8e" opacity=".55"/></pattern><pattern id="water" width="65" height="35" patternUnits="userSpaceOnUse"><rect width="65" height="35" fill="#81aba2"/><path d="M2 10h14m22 14h18M22 2h9" stroke="#b3cec0" strokeWidth="3"/></pattern></defs>
   <rect width="1000" height="470" fill="url(#grass)"/>
   <path d="M-40 380C92 329 84 225 173 182S276 199 306 141 358 9 392-30M210 189c102 25 129 97 267 88s197-18 293 52 139 87 272 62M507 277C517 177 605 163 724 158S917 185 1038 67M474 277c-49 67-71 135-72 226" fill="none" stroke="#b1b786" strokeWidth="77"/>
   <path d="M-40 380C92 329 84 225 173 182S276 199 306 141 358 9 392-30M210 189c102 25 129 97 267 88s197-18 293 52 139 87 272 62M507 277C517 177 605 163 724 158S917 185 1038 67M474 277c-49 67-71 135-72 226" fill="none" stroke="url(#sand)" strokeWidth="61"/>
   <path d="M805 487c-31-54-20-70 20-97s21-50 6-74 0-54 58-58 53-30 112-30h20v259z" fill="#d9c390"/><path d="M820 487c-31-54-20-70 20-97s21-50 6-74 0-42 58-45 53-30 112-30v246z" fill="url(#water)"/>
   <path d="M815 367 876 344" stroke="#866946" strokeWidth="39"/><path d="M815 365 876 342" stroke="#b79265" strokeWidth="29"/><path d="m820 351 9 26m2-31 9 27m3-32 9 27m4-31 9 26" stroke="#8d704d" strokeWidth="3"/><path d="m813 349 63-25m-57 58 64-25" stroke="#765b40" strokeWidth="5"/>
   <g opacity=".9"><Tree x={18} y={12} scale={1.4}/><Tree x={76} y={0} scale={1.2} tone={1}/><Tree x={119} y={35}/><Tree x={179} y={-3} scale={1.3}/><Tree x={275} y={-4} scale={1.1}/><Tree x={453} y={-8} scale={1.4}/><Tree x={923} y={-4} scale={1.5}/><Tree x={983} y={51} scale={1.6}/><Tree x={932} y={60} scale={1.1}/></g>
   <path d="M367 50h69v38h-69z" fill="#b5bd8c"/><path d="M376 55h50v24h-50z" fill="#71865c"/><path d="M377 61h49m-49 8h49" stroke="#92754f" strokeWidth="4"/><path d="m382 52 3-8 4 8m9 0 3-9 4 9m9 0 4-8 4 8" stroke="#7a984f" strokeWidth="5"/>
   <g className="world-building" tabIndex={0} role="button" aria-label="Đến quảng trường cộng đồng" onClick={()=>onNavigate('home')} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')onNavigate('home')}}><Cottage x={215} y={135} scale={1.15}/><title>Quảng trường cộng đồng</title></g>
   <g className="world-building" tabIndex={0} role="button" aria-label="Đến AI Studio" onClick={()=>onNavigate('studio')} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')onNavigate('studio')}}><Cottage x={579} y={100} scale={1.25} color="#a95442" type="studio"/><title>Xưởng sáng tạo AI</title></g>
   <g className="world-building" tabIndex={0} role="button" aria-label="Đến tháp dự án" onClick={()=>onNavigate('projects')} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')onNavigate('projects')}}><Tower x={791} y={100}/><title>Tháp dự án</title></g>
   <g className="world-building" tabIndex={0} role="button" aria-label="Đến cài đặt" onClick={()=>onNavigate('settings')} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')onNavigate('settings')}}><Cottage x={641} y={337} scale={1.0} color="#8e9a6b" type="settings"/><title>Nhà điều hành</title></g>
   <g transform="translate(372 315)"><ellipse cx="0" cy="15" rx="47" ry="14" fill="#677d55" opacity=".25"/><path d="M-37-5h74v22h-74" fill="#c4b18a"/><ellipse cx="0" cy="-5" rx="37" ry="14" fill="#ddd1ac"/><ellipse cx="0" cy="-5" rx="29" ry="9" fill="#88b3a4"/><path d="M-7-28H7V-1H-7" fill="#c2b28b"/><path d="M-15-30h30v6h-30" fill="#ded1ab"/><path className="fountain-water" d="M0-31v-18m-2 6-13 9m17-9 13 9" stroke="#d5e5c9" strokeWidth="4"/><path d="M-19 4h14m17-7h8" stroke="#d8e7cf" strokeWidth="2"/></g>
   <g stroke="#9b8056" strokeWidth="4"><path d="M120 285v41m-13-29h25m-25 10h25M480 147v34m-12-25h24m-24 8h24M906 178v43m-12-33h25m-25 9h25"/></g>
   <g fill="#a7b87d"><rect x="38" y="252" width="68" height="20"/><rect x="63" y="235" width="25" height="30"/></g>
   <g fill="#d9a878"><rect x="50" y="247" width="6" height="6"/><rect x="83" y="240" width="6" height="6"/><rect x="95" y="253" width="5" height="5"/></g>
   <g fill="#d6a967"><rect x="438" y="367" width="5" height="5"/><rect x="452" y="378" width="5" height="5"/><rect x="476" y="361" width="5" height="5"/></g>
   <Person x={466} y={240} color="#6d8591"/><Person x={278} y={247}/><Person x={552} y={394} color="#d5aa64"/>
   <Tree x={53} y={112} scale={1.15}/><Tree x={25} y={198} scale={1.4}/><Tree x={82} y={345} scale={1.5}/><Tree x={25} y={380} scale={1.3}/><Tree x={169} y={386} scale={1.15} tone={1}/><Tree x={239} y={429} scale={1.5}/><Tree x={296} y={467} scale={1.1}/><Tree x={965} y={379} scale={1.6}/><Tree x={898} y={436} scale={1.4}/><Tree x={762} y={434} scale={1.15}/><Tree x={936} y={170} scale={1.2}/>
   <g fill="#eddaa7"><path d="M126 215h8v4h-8m342 124h9v4h-9m259-130h8v4h-8m-29 228h8v4h-8"/></g>
   <g fill="#c2a77e" opacity=".7"><path d="M475 288h14v6h-14m-20 11h8v4h-8m-304-95h11v4h-11m511 4h11v4h-11m-75 24h11v4h-11"/></g>
  </svg>
  <button className="map-label map-community" onClick={()=>onNavigate('home')}><span>01</span> Quảng trường <ArrowUpRight size={11}/></button>
  <button className="map-label map-studio" onClick={()=>onNavigate('studio')}><span>02</span> AI Studio <ArrowUpRight size={11}/></button>
  <button className="map-label map-projects" onClick={()=>onNavigate('projects')}><span>03</span> Tháp dự án <ArrowUpRight size={11}/></button>
  <button className="map-label map-settings" onClick={()=>onNavigate('settings')}><span>04</span> Cài đặt <ArrowUpRight size={11}/></button>
  <div className="map-compass" aria-hidden="true"><span>N</span><svg viewBox="0 0 36 36"><path d="M18 3 25 26 18 22 11 26z" fill="#546c50"/><path d="M18 3v19l-7 4z" fill="#f8eed7"/></svg></div>
  <div className="map-caption"><span className="status-dot"/> Một thế giới đang chờ bạn khám phá</div>
 </div>;
}
