/**
 * Server-rendered pages: the configure page and the Sync Lab (the web port of Nuvio's
 * SubtitleTimingDialog). No build step, no CDN, no external fonts — everything is inline so the
 * page works on a phone next to the TV with no internet access beyond the addon itself.
 *
 * Every interpolated value goes through escapeHtml / jsonEmbed. Owned by LEAD.
 */
import { NUVIO } from '../contracts.js';

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe JSON for embedding inside a <script> block. */
export function jsonEmbed(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const BASE_CSS = `
:root{--bg:#0b0d12;--card:#151922;--card2:#1c2130;--line:#2a3142;--fg:#eef2f8;--mut:#9aa6bd;
--acc:#7c5cff;--acc2:#22d3ee;--ok:#34d399;--warn:#fbbf24;--err:#f87171;--r:14px}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--acc2)}
.wrap{max-width:920px;margin:0 auto;padding:20px 16px 80px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:26px 0 10px;letter-spacing:.01em}
h3{font-size:14px;margin:0 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em}
p.sub{color:var(--mut);margin:0 0 18px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin:0 0 14px}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 6px}
input,select,textarea{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);
background:var(--card2);color:var(--fg);font-size:15px;font-family:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);outline-offset:1px}
button{cursor:pointer;border:0;border-radius:11px;padding:13px 16px;font-size:15px;font-weight:600;
background:var(--card2);color:var(--fg);border:1px solid var(--line)}
button:hover{border-color:var(--acc)}
button.primary{background:linear-gradient(135deg,var(--acc),#5b8cff);border:0;color:#fff}
button.accent{background:linear-gradient(135deg,var(--acc2),#3bd6a0);border:0;color:#06242a}
button.ghost{background:transparent}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.row>*{flex:1 1 140px}
.row .tight{flex:0 0 auto}
.pill{display:inline-block;font-size:12px;padding:3px 9px;border-radius:999px;background:var(--card2);
border:1px solid var(--line);color:var(--mut);margin:0 6px 6px 0}
.pill.on{border-color:var(--ok);color:var(--ok)}
.pill.off{border-color:var(--err);color:var(--err)}
.cue{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);
border-radius:12px;background:var(--card2);margin:0 0 8px}
.cue .t{flex:0 0 62px;color:var(--acc2);font-variant-numeric:tabular-nums;font-size:13px}
.cue .x{flex:1;font-size:15px;line-height:1.35}
.cue button{flex:0 0 auto;padding:10px 13px}
pre{background:#0f131b;border:1px solid var(--line);border-radius:12px;padding:12px;overflow:auto;
max-height:340px;font-size:13px;white-space:pre-wrap}
.log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:var(--mut);
background:#0f131b;border:1px solid var(--line);border-radius:12px;padding:10px;min-height:44px;
max-height:220px;overflow:auto;white-space:pre-wrap}
.big{font-size:clamp(28px,9vw,46px);font-weight:700;font-variant-numeric:tabular-nums;
letter-spacing:.02em;text-align:center;padding:10px 0}
.kv{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:14px}
.kv span:first-child{color:var(--mut)}
.ok{color:var(--ok)}.bad{color:var(--err)}.warn{color:var(--warn)}
.note{font-size:13px;color:var(--mut)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:620px){.grid2{grid-template-columns:1fr}}
.footer{margin-top:26px;color:var(--mut);font-size:12.5px;text-align:center}
`;

/**
 * @param {{title:string, body:string, script?:string, lang?:string}} opts
 * @returns {string} full HTML document
 */
export function renderLayout({ title, body, script = '', lang = 'vi' }) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head><body>
<div class="wrap">${body}</div>
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

/* ── configure page ────────────────────────────────────────────────────── */

/**
 * @param {{manifestUrl:string, shareUrl:string, config:object, providers:Array<object>, stats:object}} opts
 */
export function renderConfigPage({ manifestUrl, shareUrl, config, providers = [], stats = {}, build = null, uptime = 0, secretIsEphemeral: ephemeral = false, insecure = false }) {
  const providerRows = providers.map((p) => `
    <div class="cue">
      <div class="x">
        <strong>${escapeHtml(p.name)}</strong>
        <div class="note">${escapeHtml(p.id)}${p.requiresKey ? ' · cần API key' : ' · miễn phí'}</div>
      </div>
      <label class="tight" style="margin:0"><input type="checkbox" name="provider_${escapeHtml(p.id)}"
        value="1" ${p.enabled ? 'checked' : ''} style="width:22px;height:22px"></label>
    </div>`).join('');

  const body = `
<h1>Nuvio Sync Subtitles</h1>
<p class="sub">Addon phụ đề cho Stremio · tự đồng bộ theo kiểu Nuvio (khớp câu thoại + LLM + căn chỉnh theo âm thanh)</p>

<div class="card">
  <h3>Cài vào Stremio</h3>
  <label>URL cài đặt</label>
  <input id="installUrl" readonly value="${escapeHtml(manifestUrl)}">
  <div class="row" style="margin-top:10px">
    <button class="primary tight" id="copyBtn" type="button">Sao chép</button>
    <a class="tight" href="${escapeHtml(manifestUrl)}" target="_blank" rel="noreferrer"><button type="button">Xem manifest</button></a>
  </div>
  <label>Link chia sẻ (mang theo cấu hình)</label>
  <input readonly value="${escapeHtml(shareUrl)}">
</div>

<form id="cfgForm" method="post" action="api/config">
  <div class="card">
    <h3>Nguồn phụ đề</h3>
    ${providerRows || '<p class="note">Không có provider nào.</p>'}
    <label>OpenSubtitles API key</label>
    <input name="OPENSUBTITLES_API_KEY" placeholder="${escapeHtml(config.OPENSUBTITLES_API_KEY_MASK || 'chưa đặt')}">
    <label>SubDL API key</label>
    <input name="SUBDL_API_KEY" placeholder="${escapeHtml(config.SUBDL_API_KEY_MASK || 'chưa đặt')}">
    <label>Addon phụ đề Stremio khác (URL manifest.json, cách nhau bằng dấu phẩy)</label>
    <input name="STREMIO_SUBTITLE_ADDONS" value="${escapeHtml((config.STREMIO_SUBTITLE_ADDONS || []).join(','))}"
           placeholder="https://opensubtitles-v3.strem.io/manifest.json">
  </div>

  <div class="card">
    <h3>Đồng bộ</h3>
    <label>Chế độ tự đồng bộ</label>
    <select name="SYNC_MODE">
      ${['off', 'fast', 'full'].map((m) => `<option value="${m}" ${config.SYNC_MODE === m ? 'selected' : ''}>${
        m === 'off' ? 'off — chỉ dùng offset đã lưu' : m === 'fast' ? 'fast — khớp phụ đề khác + LLM' : 'full — thêm căn chỉnh theo âm thanh'}</option>`).join('')}
    </select>
    <label>Ngân sách đồng bộ trước khi phát (ms)</label>
    <input name="AUTO_SYNC_BUDGET_MS" type="number" min="0" max="60000" value="${escapeHtml(config.AUTO_SYNC_BUDGET_MS)}">
    <label><input type="checkbox" name="ALLOW_RATE" value="1" ${config.ALLOW_RATE ? 'checked' : ''} style="width:22px;height:22px"> Cho phép sửa cả tốc độ (drift)</label>
    <label><input type="checkbox" name="AUDIO_SYNC_ENABLED" value="1" ${config.AUDIO_SYNC_ENABLED ? 'checked' : ''} style="width:22px;height:22px"> Bật căn chỉnh theo âm thanh (cần ffmpeg + file phim)</label>
    <label>Cửa sổ phân tích âm thanh (ms, 0 = cả file; 600000 cho phim dài / phim online)</label>
    <input name="AUDIO_ANALYZE_WINDOW_MS" type="number" min="0" step="30000" value="${escapeHtml(config.AUDIO_ANALYZE_WINDOW_MS ?? 0)}">
    <label><input type="checkbox" name="SHOW_ONLY_PREFERRED" value="1" ${config.SHOW_ONLY_PREFERRED ? 'checked' : ''} style="width:22px;height:22px"> Chỉ hiện ngôn ngữ ưu tiên</label>
    <label>Ngôn ngữ ưu tiên (theo thứ tự)</label>
    <input name="PREFERRED_LANGS" value="${escapeHtml((config.PREFERRED_LANGS || []).join(','))}" placeholder="vi,en">
  </div>

  <div class="card">
    <h3>LLM khớp câu thoại (tùy chọn)</h3>
    <label>Nhà cung cấp</label>
    <select name="LLM_PROVIDER">
      <option value="" ${!config.LLM_PROVIDER ? 'selected' : ''}>không dùng</option>
      <option value="groq" ${config.LLM_PROVIDER === 'groq' ? 'selected' : ''}>Groq</option>
      <option value="gemini" ${config.LLM_PROVIDER === 'gemini' ? 'selected' : ''}>Gemini</option>
    </select>
    <label>API key</label>
    <input name="LLM_API_KEY" placeholder="${escapeHtml(config.LLM_API_KEY_MASK || 'chưa đặt')}">
    <label>Model (để trống = mặc định ${escapeHtml(NUVIO.GROQ_MODEL_DEFAULT)} / ${escapeHtml(NUVIO.GEMINI_MODEL_DEFAULT)})</label>
    <input name="LLM_MODEL" value="${escapeHtml(config.LLM_MODEL || '')}">
  </div>

  <div class="card">
    <h3>Phim &amp; debrid (cho căn chỉnh theo âm thanh)</h3>
    <label>Thư mục phim trên máy này</label>
    <input name="LOCAL_MEDIA_ROOTS" value="${escapeHtml((config.LOCAL_MEDIA_ROOTS || []).join(':'))}" placeholder="/mnt/phim:/data/media">
    <div class="grid2">
      <div>
        <label>Debrid</label>
        <select name="DEBRID_PROVIDER">
          ${['', 'realdebrid', 'torbox', 'alldebrid'].map((p) => `<option value="${p}" ${config.DEBRID_PROVIDER === p ? 'selected' : ''}>${p || 'không dùng'}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Debrid API key</label>
        <input name="DEBRID_API_KEY" placeholder="${escapeHtml(config.DEBRID_API_KEY_MASK || 'chưa đặt')}">
      </div>
    </div>
  </div>

  <div class="row">
    <button class="primary" type="submit">Lưu cấu hình</button>
    <button class="ghost tight" type="reset">Khôi phục</button>
  </div>
</form>

${insecure ? `<div class="card" style="border-color:var(--warn)">
  <h3 class="warn">Cảnh báo: đang chạy trên HTTP, Stremio Web sẽ không thêm được</h3>
  <p class="note">Stremio Web mở ở <code>https://web.stremio.com</code>, và trình duyệt chặn mọi
  request <code>http://</code> từ trang https (mixed content) — bạn sẽ thấy
  <em>"NetworkError when attempting to fetch resource"</em> cho <code>manifest.json</code>.<br>
  Ba cách xử lý:<br>
  • Dùng <strong>Stremio Desktop hoặc mobile</strong> — hai bản này nhận URL http bình thường;<br>
  • Đặt <strong>Caddy</strong> trước addon để tự lấy chứng chỉ Let's Encrypt, rồi đặt
  <code>PUBLIC_URL=https://tên-miền</code> (rất quan trọng: nếu không, link phụ đề vẫn là http và
  Stremio Web sẽ chặn cả phần tải phụ đề);<br>
  • Hoặc <code>cloudflared tunnel --url http://127.0.0.1:7878</code> để có ngay một URL
  <code>https://…trycloudflare.com</code>.</p>
</div>` : ''}

${ephemeral ? `<div class="card" style="border-color:var(--warn)">
  <h3 class="warn">Cảnh báo: dữ liệu không được lưu lại</h3>
  <p class="note">Addon vừa tự sinh <code>TOKEN_SECRET</code> mới, nghĩa là thư mục dữ liệu
  (<code>DATA_DIR</code>) đang trống. Mọi link phụ đề đã đưa cho Stremio sẽ hỏng và toàn bộ
  offset đã học bị mất mỗi lần khởi động lại.<br>
  Cách sửa: gắn volume đúng vào <code>/data</code> (<code>-v subsync-data:/data</code>), hoặc
  đặt biến môi trường <code>TOKEN_SECRET</code> cố định để link cũ vẫn sống dù mất dữ liệu.</p>
</div>` : ''}

<div class="card">
  <h3>Trạng thái</h3>
  ${build ? `<div class="kv"><span>Bản đang chạy</span><span>${escapeHtml(build.version)} · ${escapeHtml(build.shortSha)}${build.builtAt ? ` · ${escapeHtml(build.builtAt)}` : ''}</span></div>` : ''}
  <div class="kv"><span>Uptime</span><span>${escapeHtml(Math.round(uptime / 60))} phút</span></div>
  <div class="kv"><span>Offset đã lưu</span><span>${escapeHtml(stats.offsets ?? 0)}</span></div>
  <div class="kv"><span>Phụ đề đã cache</span><span>${escapeHtml(stats.cachedSubs ?? 0)}</span></div>
  <div class="kv"><span>Track đã biết</span><span>${escapeHtml(stats.tracks ?? 0)}</span></div>
  <div class="kv"><span>Sự kiện đồng bộ</span><span>${escapeHtml(stats.events ?? 0)} (24h: ${escapeHtml(stats.last24h ?? 0)})</span></div>
</div>

<div class="footer">nuvio-sync · đọc <a href="docs/nuvio-parity">docs/nuvio-parity.md</a> để biết thuật toán</div>
`;

  const script = `
var f=document.getElementById('cfgForm');
f.addEventListener('submit',function(e){
  e.preventDefault();
  var fd=new FormData(f), out={}, providers=[];
  fd.forEach(function(v,k){
    if(k.indexOf('provider_')===0){ providers.push(k.slice(9)); return; }
    out[k]=v;
  });
  out.ENABLED_PROVIDERS=providers;
  fetch('api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(out)})
    .then(function(r){return r.json()})
    .then(function(j){
      if(j.ok){ location.reload(); }
      else { alert('Lỗi: '+(j.error||'không rõ')); }
    })
    .catch(function(err){ alert('Không gửi được: '+err.message); });
});
f.addEventListener('reset',function(){ setTimeout(function(){ location.reload(); },30); });
var cb=document.getElementById('copyBtn'), inp=document.getElementById('installUrl');
cb.addEventListener('click',function(){
  inp.select(); inp.setSelectionRange(0,999);
  var done=function(){ cb.textContent='Đã sao chép ✓'; setTimeout(function(){cb.textContent='Sao chép'},1500); };
  if(navigator.clipboard){ navigator.clipboard.writeText(inp.value).then(done,function(){document.execCommand('copy');done()}); }
  else { document.execCommand('copy'); done(); }
});
`;

  return renderLayout({ title: 'Nuvio Sync — cấu hình', body, script });
}

/* ── sync lab page ─────────────────────────────────────────────────────── */

/**
 * @param {{token:string, base:string}} opts
 */
export function renderSyncLabPage({ token }) {
  const body = `
<h1>Sync Lab</h1>
<p class="sub">Bản web của hộp thoại "Subtitle timing" trong Nuvio — bấm đúng câu bạn vừa nghe, hoặc để máy tự căn.</p>

<div class="card">
  <h3>Phim đang phát</h3>
  <div id="title" style="font-weight:600;margin-bottom:6px">…</div>
  <div class="note" id="file"></div>
  <label>Chọn track phụ đề</label>
  <select id="trackSel"></select>
  <div style="margin-top:10px">
    <span class="pill" id="pillOffset">offset: —</span>
    <span class="pill" id="pillRate">rate: —</span>
    <span class="pill" id="pillMethod">method: —</span>
  </div>
</div>

<div class="card">
  <h3>A · Bấm đúng câu bạn nghe (như Nuvio)</h3>
  <p class="note">Đặt <em>vị trí phim</em> bạn sắp tua tới, bấm Bắt đầu, rồi khi nghe đúng một câu trong danh sách bên dưới thì bấm vào câu đó (hoặc nhấn phím Space ở dòng đang chọn).</p>
  <div class="row">
    <div>
      <label>Vị trí phim t0 (hh:mm:ss hoặc mm:ss)</label>
      <input id="t0" placeholder="00:12:30">
    </div>
    <button class="tight primary" id="startBtn" type="button">Bắt đầu</button>
    <button class="tight ghost" id="resetTimerBtn" type="button">Đặt lại</button>
  </div>
  <div class="big" id="clock">00:00,0</div>
  <div class="row">
    <div>
      <label>Xem câu quanh thời điểm (phút)</label>
      <input id="jumpMin" placeholder="12.5">
    </div>
    <button class="tight" id="jumpBtn" type="button">Tải câu</button>
  </div>
  <div id="cues" style="margin-top:12px"></div>
</div>

<div class="card">
  <h3>B · Tự đồng bộ</h3>
  <div class="row">
    <button class="tight accent" id="autoFast" type="button">Nhanh (text + LLM)</button>
    <button class="tight primary" id="autoFull" type="button">Đầy đủ (+ âm thanh)</button>
  </div>
  <div id="autoResult" class="note" style="margin-top:10px"></div>
  <label>Gắn nguồn phim cho máy này (để căn theo âm thanh)</label>
  <div class="row">
    <input id="mediaPath" placeholder="/mnt/phim/Movie.mkv hoặc magnet:?xt=...">
    <button class="tight" id="attachBtn" type="button">Gắn</button>
  </div>
</div>

<div class="card">
  <h3>C · Chỉnh tay</h3>
  <div class="grid2">
    <div>
      <label>Offset (ms)</label>
      <input id="manOffset" type="number" step="10" value="0">
    </div>
    <div>
      <label>Rate (1 = không đổi tốc độ)</label>
      <input id="manRate" type="number" step="0.001" value="1">
    </div>
  </div>
  <div class="row" style="margin-top:10px">
    <button class="tight primary" id="applyManual" type="button">Áp dụng</button>
    <button class="tight ghost" id="resetBtn" type="button">Xóa đồng bộ</button>
  </div>
  <div class="note" style="margin-top:10px" id="limits"></div>
</div>

<div class="card">
  <h3>Xem trước</h3>
  <pre id="preview">…</pre>
  <a id="dl" href="#"><button type="button">Tải .srt đã đồng bộ</button></a>
</div>

<div class="card">
  <h3>Nhật ký</h3>
  <div class="log" id="log"></div>
</div>
`;

  const script = `
var TOKEN=${jsonEmbed(token)};
var S={session:null,trackId:null,t0:0,running:false,startedAt:0,selected:0};
var $=function(id){return document.getElementById(id)};
function log(msg){var el=$('log');el.textContent=('['+new Date().toLocaleTimeString()+'] '+msg+'\\n'+el.textContent).slice(0,4000)}
function fmt(ms){ms=Math.max(0,Math.round(ms));var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
 s=s%60;m=m%60;var cs=Math.round((ms%1000)/100);
 return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+','+cs}
function parseTs(v){
  v=String(v||'').trim(); if(!v) return null;
  if(/^\\d+(\\.\\d+)?$/.test(v)) return Math.round(parseFloat(v)*60000);
  var p=v.split(':').map(Number); if(p.some(function(n){return !isFinite(n)})) return null;
  if(p.length===3) return Math.round((p[0]*3600+p[1]*60+p[2])*1000);
  if(p.length===2) return Math.round((p[0]*60+p[1])*1000);
  return null;
}
function api(path,opt){
  return fetch(path,opt).then(function(r){return r.json().then(function(j){return {ok:r.ok,status:r.status,json:j}})})
    .then(function(res){
      if(!res.ok||res.json&&res.json.ok===false){ throw new Error((res.json&&res.json.error)||('HTTP '+res.status)); }
      return res.json;
    });
}
function loadSession(){
  return api('/api/synclab/session?t='+encodeURIComponent(TOKEN)).then(function(s){
    S.session=s;
    $('title').textContent=s.title||s.videoKey||'';
    $('file').textContent=s.filename||'';
    var sel=$('trackSel'); sel.innerHTML='';
    (s.tracks||[]).forEach(function(t){
      var o=document.createElement('option');
      o.value=t.id;
      o.textContent=(t.langName||t.lang||'?')+' · '+(t.provider||'')+(t.offsetMs?' · '+(t.offsetMs>0?'+':'')+t.offsetMs+'ms':'');
      sel.appendChild(o);
    });
    S.trackId=s.selectedTrackId||((s.tracks||[])[0]||{}).id||null;
    if(S.trackId) sel.value=S.trackId;
    var st=s.settings||{};
    $('limits').innerHTML='';
    $('limits').textContent='Giới hạn kiểu Nuvio: ±'+(st.clampMaxMs||180000)+'ms, bước '+(st.stepMs||100)+
      'ms, bù phản xạ '+(st.reactionCompensationMs||300)+'ms. LLM: '+((s.llm&&s.llm.configured)?s.llm.provider:'chưa cấu hình')+
      '. Khi Stremio tự tải phụ đề, addon chỉ áp dụng nếu có bằng chứng đồng thuận (≥2 phụ đề tham chiếu khớp nhau, '+
      'hoặc âm thanh/LLM); nếu chỉ có một tham chiếu thì nó chỉ ĐỀ XUẤT — bấm "Tự đồng bộ" ở đây để áp dụng ngay.';
    var t=(s.tracks||[]).filter(function(x){return x.id===S.trackId})[0];
    if(t){ $('manOffset').value=t.offsetMs||0; $('manRate').value=t.rate||1;
      $('pillOffset').textContent='offset: '+(t.offsetMs||0)+'ms';
      $('pillRate').textContent='rate: '+(t.rate||1);
      $('pillMethod').textContent='method: '+(t.method||'chưa có'); }
    log('đã tải session: '+(s.tracks||[]).length+' track');
    return loadCues(null);
  });
}
function loadCues(fromMs){
  var q='/api/synclab/cues?t='+encodeURIComponent(TOKEN)+(S.trackId?'&trackId='+encodeURIComponent(S.trackId):'');
  if(fromMs!=null) q+='&fromMs='+fromMs+'&limit=60';
  return api(q).then(function(r){
    S.cues=r.cues||[];
    S.selected=0;
    renderCues();
    log('tải '+(S.cues.length)+' câu (tổng '+(r.total||'?')+')');
  });
}
function renderCues(){
  var host=$('cues'); host.innerHTML='';
  S.cues.forEach(function(c,i){
    var d=document.createElement('div'); d.className='cue';
    d.innerHTML='<div class="t">'+fmt(c.start).replace(',','.')+'</div><div class="x"></div>'+
      '<button type="button" data-i="'+i+'">Nghe rồi</button>';
    d.querySelector('.x').textContent=c.text;
    host.appendChild(d);
  });
  host.querySelectorAll('button').forEach(function(b){
    b.addEventListener('click',function(){ tap(parseInt(b.getAttribute('data-i'),10)); });
  });
  if(S.cues.length) log('câu đầu: '+fmt(S.cues[0].start));
}
function tap(i){
  var cue=S.cues[i]; if(!cue){ log('chưa có câu nào'); return; }
  var elapsed=S.running?(Date.now()-S.startedAt):0;
  var videoPositionMs=S.t0+elapsed;
  var delay=videoPositionMs-cue.start-300;
  log('bấm câu '+i+' · vị trí phim '+fmt(videoPositionMs)+' · cue '+fmt(cue.start)+' → delay '+delay+'ms');
  apply({mode:'tap',videoPositionMs:videoPositionMs,cueStartMs:cue.start});
}
function apply(payload){
  if(!S.trackId){ log('chưa chọn track'); return Promise.resolve(); }
  payload.t=TOKEN; payload.trackId=S.trackId;
  return api('/api/synclab/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){
      log('áp dụng: method='+r.method+' offset='+r.offsetMs+'ms rate='+r.rate+' confidence='+(r.confidence||0).toFixed(2));
      $('pillOffset').textContent='offset: '+r.offsetMs+'ms';
      $('pillRate').textContent='rate: '+r.rate;
      $('pillMethod').textContent='method: '+r.method;
      $('manOffset').value=r.offsetMs; $('manRate').value=r.rate;
      return preview();
    })
    .catch(function(e){ log('lỗi áp dụng: '+e.message); });
}
function preview(){
  if(!S.trackId) return Promise.resolve();
  var url='/api/synclab/preview?t='+encodeURIComponent(TOKEN)+'&trackId='+encodeURIComponent(S.trackId);
  $('dl').setAttribute('href',url);
  return fetch(url).then(function(r){return r.text()}).then(function(t){
    $('preview').textContent=t.split('\\n').slice(0,80).join('\\n');
  }).catch(function(e){ $('preview').textContent='lỗi: '+e.message; });
}
function autoSync(mode){
  if(!S.trackId){ log('chưa chọn track'); return; }
  $('autoResult').textContent='đang đồng bộ ('+mode+')…';
  log('bắt đầu auto '+mode);
  api('/api/synclab/auto',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({t:TOKEN,trackId:S.trackId,mode:mode})})
    .then(function(r){
      var x=r.result||{};
      $('autoResult').textContent='method='+x.method+' · offset='+x.offsetMs+'ms · rate='+x.rate+
        ' · confidence='+(x.confidence||0).toFixed(2)+' · mẫu='+(x.samples||0)+(x.error?(' · '+x.error):'');
      log('auto xong: '+JSON.stringify(x.detail||{}).slice(0,300));
      return loadSession().then(function(){ return preview(); });
    })
    .catch(function(e){ $('autoResult').textContent='lỗi: '+e.message; log('auto lỗi: '+e.message); });
}
function tick(){
  if(!S.running) return;
  $('clock').textContent=fmt(Date.now()-S.startedAt);
  requestAnimationFrame(tick);
}
document.addEventListener('DOMContentLoaded',function(){
  loadSession().then(preview).catch(function(e){ log('không tải được session: '+e.message); });

  $('startBtn').addEventListener('click',function(){
    var ms=parseTs($('t0').value);
    if(ms==null){ log('t0 không hợp lệ, ví dụ 12:30 hoặc 00:12:30'); return; }
    S.t0=ms; S.startedAt=Date.now(); S.running=true;
    log('bắt đầu đo từ '+fmt(S.t0));
    tick();
  });
  $('resetTimerBtn').addEventListener('click',function(){ S.running=false; $('clock').textContent='00:00,0'; });
  $('jumpBtn').addEventListener('click',function(){
    var ms=parseTs($('jumpMin').value); loadCues(ms==null?null:ms);
  });
  $('trackSel').addEventListener('change',function(){ S.trackId=$('trackSel').value;
    var t=(S.session.tracks||[]).filter(function(x){return x.id===S.trackId})[0];
    if(t){ $('manOffset').value=t.offsetMs||0; $('manRate').value=t.rate||1; }
    loadCues(null).then(preview); });
  $('autoFast').addEventListener('click',function(){ autoSync('fast'); });
  $('autoFull').addEventListener('click',function(){ autoSync('full'); });
  $('applyManual').addEventListener('click',function(){
    apply({mode:'offset',offsetMs:Number($('manOffset').value)||0,rate:Number($('manRate').value)||1});
  });
  $('resetBtn').addEventListener('click',function(){ apply({mode:'reset'}); });
  $('attachBtn').addEventListener('click',function(){
    var v=$('mediaPath').value.trim(); if(!v){ log('nhập đường dẫn hoặc magnet'); return; }
    var payload={t:TOKEN,value:v};
    api('/api/synclab/media',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){ log('đã gắn nguồn phim: '+JSON.stringify(r)); })
      .catch(function(e){ log('lỗi gắn nguồn: '+e.message); });
  });
  document.addEventListener('keydown',function(e){
    if(e.code==='Space'){ e.preventDefault(); tap(S.selected); }
    if(e.code==='ArrowDown'){ e.preventDefault(); S.selected=Math.min(S.cues.length-1,S.selected+1); }
    if(e.code==='ArrowUp'){ e.preventDefault(); S.selected=Math.max(0,S.selected-1); }
  });
});
`;

  return renderLayout({ title: 'Nuvio Sync — Sync Lab', body, script });
}
