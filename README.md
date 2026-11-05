# nuvio-sync — addon phụ đề Stremio tự đồng bộ kiểu Nuvio

[![docker](https://github.com/6zev/subsync/actions/workflows/docker.yml/badge.svg)](https://github.com/6zev/subsync/actions/workflows/docker.yml)
![ghcr](https://img.shields.io/badge/ghcr.io-6zev%2Fsubsync-2496ed?logo=docker&logoColor=white)

Addon phụ đề cho Stremio, port tính năng **Auto Subtitle Sync** của
[Nuvio](https://github.com/NuvioMedia/NuvioMobile) sang môi trường addon:
tự căn chỉnh thời gian phụ đề trước khi Stremio phát, nhớ offset theo từng video,
và có một trang **Sync Lab** để bạn tự căn bằng một cú bấm.

```bash
cd /root/subsync
npm start                     # http://127.0.0.1:7878
# Stremio -> Addons -> Install from URL -> http://<IP>:7878/manifest.json
```

Không cần npm install: **0 dependency runtime**, chỉ cần Node ≥ 22.
`ffmpeg` là tuỳ chọn (chỉ dùng cho nhánh căn theo âm thanh).

## Chạy bằng Docker (khuyến nghị)

```bash
docker run -d --name subsync \
  -p 7878:7878 \
  -v subsync-data:/data \
  -e PUBLIC_URL=http://192.168.1.10:7878 \
  ghcr.io/6zev/subsync:latest
```

hoặc `docker compose up -d` (dùng [`docker-compose.yml`](docker-compose.yml) trong repo, có
sẵn chỗ khai báo volume thư mục phim).

| Việc | Lệnh |
| --- | --- |
| Xem log | `docker logs -f subsync` |
| Sức khoẻ | `curl localhost:7878/healthz` → kèm `build.sha` để biết đang chạy bản nào |
| Cấu hình | mở `http://<IP>:7878/configure` (ghi vào volume `/data`) |
| Cập nhật | `docker compose pull && docker compose up -d` |
| Bản nhẹ, không có âm thanh | build với `--build-arg INSTALL_FFMPEG=0` |

Ảnh hỗ trợ **linux/amd64 + linux/arm64**. Biến môi trường nhận đúng như `.env.example`.

**Build identity.** CI bake commit sha vào image (`ARG GIT_SHA`), nên `/healthz` và `/stats`
trả về `build.sha` / `build.shortSha`, trang `/configure` hiện "Bản đang chạy", và log khởi
động in `nuvio-sync v0.1.0 (a260193, built ...)`. Nhờ vậy không phải đoán deployment đang là
build nào — chỉ cần `curl .../healthz`. Chạy trực tiếp từ source (không Docker) thì sha được
đọc từ git checkout; không có git thì báo `unknown`.

**Dữ liệu có bị mất khi restart không?** Nếu `DATA_DIR` trống, addon tự sinh `TOKEN_SECRET`
mới → mọi link phụ đề đã đưa cho Stremio hỏng và toàn bộ offset đã học bị mất. Addon sẽ
**cảnh báo rõ trong log và trên trang `/configure`** khi điều đó xảy ra. Hai cách chống:
gắn volume đúng vào `/data` (`-v subsync-data:/data`), hoặc đặt biến `TOKEN_SECRET` cố định
(link cũ vẫn sống dù mất dữ liệu).

---

## 1. Nuvio làm thế nào, và addon này thay thế bằng gì

Nuvio chạy *trong* player nên nó có sẵn hai thứ mà addon không có: **track phụ đề
built-in của file** (làm mốc tham chiếu) và **đồng hồ phát lại**.

Đọc mã nguồn NuvioTV (`PlayerRuntimeControllerSubtitleTiming.kt`) thì thuật toán là:

| Bước | Nuvio | Hằng số |
| --- | --- | --- |
| 1 | gom **5 dòng liên tiếp** từ track built-in | `AUTO_SYNC_SOURCE_LINE_COUNT = 5` |
| 2 | gửi 5 dòng đó + phụ đề addon cho **LLM** (Groq `llama-3.1-8b-instant` / Gemini `gemini-3.5-flash`) để ghép cặp câu | — |
| 3 | lặp tối đa **3 lần**, gom offset từng cặp, lấy **median** | `AUTO_SYNC_MAX_ATTEMPTS = 3` |
| 4 | áp dụng `delay = vị trí phát − cue.start − 300ms`, kẹp ±180000ms, bước 100ms | `REACTION_COMPENSATION_MS = 300` |
| 5 | `persistTrackPreference()` — nhớ delay cho lần sau | — |

Addon này giữ nguyên *công thức và hằng số*, nhưng thay đầu vào:

| Nuvio cần | nuvio-sync dùng |
| --- | --- |
| track built-in làm mốc | **các phụ đề khác của cùng video** (theo `videoHash`/tên release) lấy từ mọi provider → **đồng thuận đa tham chiếu** |
| đồng hồ player | **track âm thanh thật** của phim: `ffmpeg` trích PCM → VAD năng lượng → tương quan chéo với "đường bao hội thoại" của phụ đề |
| LLM ghép câu | **giữ nguyên**: cùng 5 dòng, cùng Groq/Gemini, cùng median |
| người dùng bấm đúng câu vừa nghe | **Sync Lab** (web): đồng hồ bấm giây → `videoPositionMs − cueStartMs − 300` |
| `persistTrackPreference()` | bảng `offsets` trong SQLite, khoá theo `videoKey` + `trackId` |

Vì Stremio không cho addon đặt độ trễ của player, offset được áp **bằng cách viết lại
timestamp rồi mới trả file**:

```
newStart = round(oldStart * rate) + offsetMs
```

Nghĩa là file Stremio nhận được *đã đúng giờ sẵn* — và còn sửa được cả **drift**
(`rate`), thứ mà Nuvio (chỉ có delay) không làm được. Chi tiết đầy đủ:
[docs/nuvio-parity.md](docs/nuvio-parity.md).

---

## 2. Có gì trong đó

- **Provider**: [SubSense](https://github.com/NepiRaw/Stremio-SubSense) (aggregator, **không cần key**),
  OpenSubtitles v3 (kể cả tìm theo *hash của file*), SubDL, Podnapisi,
  addon phụ đề Stremio khác, file phụ đề cạnh phim trên máy, và bộ `samples/` để chạy offline.
- **Xếp hạng** theo hash file → tên release → ngôn ngữ ưu tiên → lượt tải, có chống trùng.
- **Ba tầng đồng bộ**: `text` (đồng thuận đa tham chiếu) → `llm` (Groq/Gemini) → `audio`
  (`ffmpeg` + VAD + tương quan chéo; ưu tiên `alass`, `ffsubsync` khi có).
- **Sync Lab** — bản web của hộp thoại "Subtitle timing" trong Nuvio:
  - **A. Bấm đúng câu vừa nghe**: đặt mốc `t0`, bấm Bắt đầu, nghe thấy đúng câu nào thì
    bấm vào câu đó (hoặc Space). Công thức y hệt Nuvio, có bù 300 ms.
  - **B. Tự động**: Nhanh (text + LLM) / Đầy đủ (+ âm thanh) / chỉÂm thanh.
  - **C. Chỉnh tay**: offset (ms) + rate, và Reset.
  - Xem trước và tải `.srt` đã đồng bộ.
- **Nhớ offset**: căn một lần, các lần sau tức thì (cache SQLite).
- **Không bao giờ làm bạn chờ**: khi Stremio tải phụ đề, addon chỉ giữ tối đa
  `AUTO_SYNC_BUDGET_MS` (mặc định 9 s); quá hạn thì trả file gốc ngay và **đồng bộ tiếp ở
  nền** — lần chọn tiếp theo đã có sẵn bản đã căn.
- **An toàn**: phụ đề là dữ liệu không tin cậy (parse không ném lỗi), token ký HMAC,
  secret không bao giờ lộ ra API, mọi truy vấn ra ngoài đều có timeout và bị cô lập.
  Upstream trả 200 kèm trang lỗi → addon trả **502** chứ không đưa phụ đề rỗng cho player;
  câu quảng cáo của bản free bị lọc bỏ; bộ `samples/` chỉ hiện khi không có nguồn thật nào.

---

## 3. Cài và dùng

```bash
node src/index.js            # hoặc: npm start
# tuỳ chọn:
PORT=7878 HOST=0.0.0.0 PUBLIC_URL=http://192.168.1.10:7878 node src/index.js
```

Mở `http://<IP>:7878/configure` để cấu hình, rồi dán URL manifest vào
**Stremio → Addons → Install from URL**. Nếu Stremio ở máy khác, đặt `PUBLIC_URL`
thành địa chỉ IP LAN mà máy đó truy cập được.

Cấu hình được lưu ở `data/config.json` (đè lên `.env`). Xem `.env.example`.

**Chạy được ngay không cần key**: provider `local` luôn đọc thư mục `samples/`
(3 phụ đề demo) nên bạn cài vào Stremio là thấy ngay 3 track và thử được toàn bộ luồng.

### Bảng chọn nhanh

| Bạn muốn | Cần gì | Đặt gì |
| --- | --- | --- |
| Thấy nhiều phụ đề hơn | API key | `OPENSUBTITLES_API_KEY` (và/hoặc `SUBDL_API_KEY`) |
| Chỉ đồng bộ bằng tay trong Sync Lab | — | `SYNC_MODE=off` |
| Thêm nguồn sub không cần key | — | đã bật sẵn (`SUBSENSE_URL`) |
| Tự đồng bộ theo phụ đề khác (nhanh) | — | `SYNC_MODE=fast` |
| Thêm tầng LLM | key Groq/Gemini | `LLM_PROVIDER` + `LLM_API_KEY` |
| Căn theo âm thanh | `ffmpeg` + file phim truy cập được | `AUDIO_SYNC_ENABLED=true`, `SYNC_MODE=full`, `LOCAL_MEDIA_ROOTS` |

---

## 4. Ba tầng đồng bộ, và vì sao có ngưỡng tin cậy

### 4.1 `text` — đồng thuận đa tham chiếu

Cùng một video thường có nhiều phụ đề. Addon lấy tối đa 4 track khác làm tham chiếu và
tính offset với từng cái, rồi **bỏ phiếu**:

- ghép dòng gần như trùng nhau (bỏ dấu, bỏ thẻ ASS/HTML) → histogram delta bước 250 ms
  → RANSAC → `(rate, offset)`;
- nếu khác ngôn ngữ (không dòng nào khớp) → **tương quan đường bao hội thoại**, không phụ
  thuộc ngôn ngữ;
- các kết quả được gom cụm (dung sai 400 ms), cụm nhiều phiếu nhất thắng;
- **hoà phiếu → không sửa gì** (thà để nguyên còn hơn phá file đang đúng).

**Quan trọng:** một tham chiếu duy nhất *không thể chứng minh file nào sai*. Vì vậy kết quả
một-nguồn bị hạ tin cậy xuống dưới ngưỡng áp dụng (0.45) và chỉ được **đề xuất**;
addon không tự sửa. Máy tự sửa khi:

- ≥ 2 tham chiếu đồng ý, **hoặc**
- bạn bấm "Tự đồng bộ" trong Sync Lab (ý bạn đã rõ), **hoặc**
- có bằng chứng tuyệt đối: khớp hash file, hoặc âm thanh/LLM xác nhận.

### 4.2 `llm` — cổng nguyên của Nuvio

5 dòng tham chiếu liên tiếp, tối đa 3 cửa sổ rải khắp file, gửi Groq/Gemini, JSON
`{"matches":[{"ref":i,"target":j}]}` (parse chịu được code fence, văn xuôi, 1-based lẫn
0-based), gom offset từng cặp rồi lấy **median**, loại ngoại lai ±3 s, kẹp ±180 s.

### 4.2b SubSense làm nguồn sub

SubSense là addon Stremio tổng hợp OpenSubtitles / SubDL / Podnapisi / SubSource / Wyzie /
Subf2m / Kitsunekko / Jimaku / AnimeTosho / Gestdown / YIFY / TVsubtitles. Config của nó nằm
trong **path** (`/:config/manifest.json`) và `parseConfigParam()` nhận JSON URL-encoded, nên
addon tự dựng config và gọi thẳng — **không cần API key nào của bạn**:

```json
{ "languages": ["vi", "en"], "maxSubtitles": 10, "userId": "nuvio-sync" }
```

Đo thật trên máy này: `tt1375666` → **9–20 track trong 0.8–1.0 s** (một request). Đây cũng là
cách rẻ nhất để có **nhiều tham chiếu** cho tầng đồng thuận.

### Nhưng URL mà SubSense trả về thì KHÔNG tải trực tiếp được

Đây là phần tốn công nhất, đều là kết quả đo thật (không đoán):

| URL SubSense trả về | Kết quả khi tự tải |
| --- | --- |
| `sub.wyzie.io/...?tok=...` | **401** "Download link invalid or expired" |
| `http://127.0.0.1:11470/subtitles.srt?from=<url thật>` | ECONNREFUSED — trỏ vào máy của *người chơi* |
| `subsense.nepiraw.com/api/yify/proxy/...` | ✅ 200 |
| `subsense.nepiraw.com/api/subtitle/{format}/{url}` (proxy của họ) | ✅ 200 |

Nên addon **viết lại mọi link thô** thành dạng proxy của SubSense:
`{SUBSENSE_URL}/api/subtitle/srt/{url-gốc}` — bỏ `?from=` nếu link trỏ về `127.0.0.1`, và
**không** percent-encode URL bên trong (encode thì SubSense trả `invalid URL`; đã thử cả hai).
Việc này nằm ở `resolveDownload()` với cờ `meta.rewritesHttp`.

### Quảng cáo của bản free

Bản public nhét **một câu quảng cáo ngay đầu phụ đề** — qua Wyzie (`You're on the free plan…`,
`store.wyzie.io`) hoặc qua link trực tiếp của OpenSubtitles (`Watch Online Movies and Series
for FREE`, `www.osdb.link/lm`). Addon **tự lọc bỏ** các câu này trước khi trả cho Stremio
(`stripPromoCues`, dựa trên đúng những mẫu đã gặp), và xếp URL Wyzie xuống dưới mirror sạch.

Muốn sạch hoàn toàn: tự host SubSense rồi đặt `SUBSENSE_URL`. Cách khác không cần code: dán
manifest URL của SubSense (đã cấu hình) vào `STREMIO_SUBTITLE_ADDONS`.

### Kỳ vọng thực tế về đồng bộ

SubSense trả nhiều phụ đề **của các bản phim khác nhau** (bản chiếu rạp / bản BluRay / bản
chiếu web). Đo thật với Inception: hai phụ đề tiếng Việt lệch nhau **59.4 s** — addon báo
"đề xuất −59400 ms, tin cậy 0.26" và **không tự sửa**, đúng như thiết kế: nó không thể biết
bản nào khớp với file bạn đang xem. Muốn áp thì mở Sync Lab bấm một nút, hoặc bật thêm tầng
`audio` (căn theo âm thanh thật) để có bằng chứng quyết định.

### 4.3 `audio` — căn theo âm thanh thật

1. `ffmpeg` trích PCM 8 kHz mono;
2. RMS theo hop 20 ms → ngưỡng VAD thích ứng → mask "có tiếng nói";
3. mask "có hội thoại" của phụ đề (theo đúng biên cue);
4. tìm độ trễ làm hai mask chồng khớp nhất (quét thô 100 ms, tinh chỉnh 20 ms);
5. tin cậy = độ nổi của đỉnh **và** điểm khớp tuyệt đối — nếu chưa đủ chắc thì mới gọi
   `alass` (khi có phụ đề tham chiếu) rồi `ffsubsync`.

Cùng một đoạn audio, ước lượng của chính addon và `ffsubsync` được đối chiếu: lệch nhau
> 1.5 s thì không tin `ffsubsync`, dùng ước lượng nội bộ và ghi lại chi tiết.

**Phim dài / phim online**: `ffmpeg` phải tải đúng những byte nó giải mã, nên phân tích cả
phim 2 giờ = tải vài GB. Đặt `AUDIO_ANALYZE_WINDOW_MS=600000` để chỉ phân tích **cửa sổ 10
phút giàu hội thoại nhất** — addon tự chọn cửa sổ đó, kết quả offset không đổi.

## 4b. Tốc độ (đo trên máy này, không dùng LLM)

| Việc | 200 cue | 1200 cue | 2000 cue |
| --- | --- | --- | --- |
| `text` cùng ngôn ngữ (neo + RANSAC) | **29 ms** | **105 ms** | **220 ms** |
| `text` khác ngôn ngữ (tương quan mask) | 42 ms | 354 ms | 229 ms |
| `llm` (Groq/Gemini, mỗi lần thử) | — | 1000–3000 ms | — |

| Việc | Thời gian |
| --- | --- |
| Liệt kê sub (SubSense, 1 request, 9–20 track) | 765–1035 ms |
| Tải + căn lần đầu (sub 150 KB từ SubSense) | ~2.8 s |
| Phục vụ lần 2 trở đi (cache) | 5–52 ms |
| Căn theo âm thanh, phim 10 phút (cả file) | 0.9 s (ffmpeg 420 + VAD 136 + tương quan 50) |
| Căn theo âm thanh, cửa sổ 5 phút | 0.56 s |
| Giải mã PCM | ~0.8–1.1 ms cho mỗi giây phim |

**Kết luận: không dùng LLM thì sync nhanh — hàng chục đến hàng trăm ms**, nhanh hơn LLM
khoảng 10–30 lần. Không mất chức năng: tầng `text` vẫn xử lý được cả tham chiếu **khác ngôn
ngữ** bằng tương quan đường bao hội thoại. LLM chỉ đáng bật khi quá ít tham chiếu.

---

## 5. HTTP API (bản đầy đủ: [docs/api.md](docs/api.md))

```
GET  /manifest.json
GET  /configure                         trang cấu hình
GET  /api/config | POST /api/config
GET  /subtitles/:type/:id[/:extra].json
GET  /s/:token/:name.srt                trả phụ đề ĐÃ căn (Stremio gọi cái này)
GET  /synclab?t=TOKEN                   Sync Lab
GET  /api/synclab/session|cues|preview|tracks
POST /api/synclab/apply   {mode:'tap'|'offset'|'reset', …}
POST /api/synclab/auto    {mode:'fast'|'full', methods?:['text','llm','audio']}
POST /api/synclab/media   {value:'/duong/dan/phim.mkv' | 'magnet:?xt=…'}
GET  /healthz | /stats
```

Header `x-nuvio-sync-method|offset-ms|rate|confidence` trên mỗi file phụ đề trả về cho
biết nó đã bị dịch bao nhiêu và bằng cách nào.

---

## 6. Kiểm thử

```bash
npm test          # 120 test (node:test, không cần dependency)
npm run test:e2e  # bật HTTP server thật rồi gọi như Stremio + 1 video ffmpeg thật
```

Bộ test bao gồm: round-trip parser SRT/VTT/ASS + mojibake; kẹp biên và công thức 300 ms;
phục hồi offset **và** drift với dữ liệu nhiễu; đồng thuận/hoà phiếu; LLM với fetch giả
(kể cả reply hỏng); VAD + tương quan trên WAV tự sinh; **pipeline âm thanh đầy đủ trên
video .mkv thật**; sắp hạng provider; chống XSS ở trang web; và e2e toàn bộ addon.

---

## 6b. CI/CD

`.github/workflows/docker.yml` chạy 2 job:

1. **test** — `npm test` (120 test) trên Node 24, có `ffmpeg` để chạy cả test âm thanh;
2. **build** — `docker buildx` dựng **linux/amd64 + linux/arm64** (kèm `GIT_SHA` + `BUILD_TIME`
   để container tự khai báo bản build), đẩy lên
   `ghcr.io/6zev/subsync` với tag: `latest` (nhánh mặc định), tên nhánh, `sha-<ngắn>`, và
   `v1.2.3` / `1.2` khi push tag. Có cache `type=gha`, kèm SBOM + provenance.

Job `build` chỉ chạy khi `test` xanh.

## 7. Cấu trúc

```
src/
  contracts.js        hợp đồng giao diện đóng băng (typedef + hằng số Nuvio)
  env.js              cấu hình: defaults <- .env <- data/config.json
  server.js           HTTP server        index.js  entry point
  addon/              manifest · tokens (HMAC) · router · pipeline (tải/căn/trả phụ đề)
  sync/               subtitles · shift · correlate · textAlign · llmMatch · audioAlign
  providers/          subsense · opensubtitles · subdl · podnapisi · addon-proxy · local · rank
  media/              hash (OpenSubtitles) · resolver · debrid (RD/TorBox/AllDebrid)
  synclab/routes.js   API của Sync Lab
  web/pages.js        trang HTML (không CDN, không build step)
  store/              SQLite: offsets · subs · tracks · kv · events
samples/              3 phụ đề demo (en, sdh.en, vi lệch +2500 ms)
docs/                 nuvio-parity · architecture · api
Dockerfile            node:24-slim + ffmpeg (+ alass trên amd64)
docker-compose.yml    1 service, volume /data cho offset & cache
.github/workflows/    test -> buildx -> ghcr.io (amd64 + arm64)
test/                 120 test
```

---

## 8. Giới hạn đã biết

- **Stremio không có API để addon chỉnh độ trễ của player** → offset được áp lúc *tải file*.
  Đang xem mà đổi offset thì phải chọn lại phụ đề trong Stremio.
- Đổi offset một lần là áp cho **mọi** lần chọn track đó (đúng như `persistTrackPreference`
  của Nuvio). Muốn về gốc: nút Reset trong Sync Lab.
- Căn theo âm thanh cần addon **truy cập được file phim** (ổ đĩa cùng máy, URL trực tiếp,
  hoặc debrid). Nếu phim phát qua torrent trong Stremio thì dùng ô "Gắn nguồn phim" để dán
  magnet — với debrid đã cấu hình, addon sẽ tự lấy link.
- Chỉ nhận `type` movie/series với id `tt…` (IMDB).
- Cảnh báo: tìm theo hash sẽ **tiêu 1 lượt tải/ngày** của OpenSubtitles, nên addon chỉ gọi
  `/download` khi Stremio thật sự tải phụ đề (lazy).
- SubSource: chưa triển khai (endpoint công khai không ổn định) — xem `docs/architecture.md`.

## 9. Hướng phát triển

- Whisper cục bộ (`faster-whisper`) để căn cả khi không có phụ đề tham chiếu;
- nhận diện PGS/VobSub → OCR làm mốc (giống nhánh ML Kit của Nuvio TV);
- provider SubSource/SourceForge, và chế độ "so khớp cả corpus" cho phim có 20+ track.
