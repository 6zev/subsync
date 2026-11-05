# HTTP API

Mọi endpoint trả JSON (`content-type: application/json`) trừ file phụ đề và trang HTML.
Mọi response có CORS `*` để Stremio Web gọi được. Lỗi luôn có dạng `{ "ok": false, "error": "…" }`.

## Addon (giao thức Stremio)

### `GET /manifest.json`
Manifest addon phụ đề. Cũng có thể nhúng cấu hình vào URL:
`GET /<configToken>/manifest.json` — dùng cho link chia sẻ từ trang `/configure`.

### `GET /subtitles/:type/:id.json`
### `GET /subtitles/:type/:id/:extra.json`

- `type`: `movie` | `series`
- `id`: `tt1234567` (movie) hoặc `tt1234567:2:5` (series, mùa:tập)
- `extra`: chuỗi URL-encode `videoHash=…&videoSize=…&filename=…` (Stremio tự gửi)

```json
{
  "subtitles": [
    { "id": "opensubtitles:1234", "url": "http://host/s/<token>/Movie.2024.vi.srt",
      "lang": "vie", "label": "Vietnamese" }
  ]
}
```

`lang` luôn là mã ISO 639-2/B 3 chữ cái (Stremio yêu cầu).

### `GET /stream/:type/:id.json`

Trả danh sách nguồn phát bằng cách hỏi lại các addon stream trong `MEDIA_SOURCE_ADDON`
(mỗi dòng một manifest URL) — cùng câu hỏi Stremio đã hỏi addon đó, nên link debrid/torrent
hiện lại đúng trong mục Sources.

- `type`: `movie` | `series`; `id`: `tt1234567` hoặc `tt1234567:2:5`.
- Chỉ giữ entry có `url` http(s) hoặc `infoHash` 40 hex; entry trùng bị lọc; tối đa 80 entry.
- Không cấu hình gì (hoặc addon lỗi) → `{"streams":[]}`, không phải lỗi HTTP.
- Cache trong bộ nhớ 3 phút theo `type:id` + danh sách addon.

```json
{
  "streams": [
    { "name": "DMM Cast", "title": "Movie.2024.1080p.WEB-DL.mkv",
      "url": "https://debrid-cdn.example/d/…/Movie.2024.1080p.WEB-DL.mkv" }
  ]
}
```

### `GET /s/:token/:name.srt`

Tải phụ đề **đã được căn**. Đây là lúc addon làm việc nặng:

1. token được xác minh (HMAC) → `videoKey` + `trackId`;
2. có offset đã lưu (tay hoặc tự động) → áp ngay, phục vụ từ cache;
3. chưa có và `SYNC_MODE != off` → chạy thang đồng bộ trong tối đa `AUTO_SYNC_BUDGET_MS`,
   quá hạn thì trả file gốc và **đồng bộ tiếp ở nền**;
4. không có cách nào → trả file gốc nguyên trạng.

Header cho biết kết quả:

| Header | Ý nghĩa |
| --- | --- |
| `x-nuvio-sync-method` | `text` \| `llm` \| `audio` \| `manual-tap` \| `manual` \| `none` |
| `x-nuvio-sync-offset-ms` | dịch bao nhiêu ms |
| `x-nuvio-sync-rate` | hệ số drift (1 = không đổi) |
| `x-nuvio-sync-confidence` | 0..1 |

---

## Cấu hình

### `GET /configure`
Trang cấu hình (HTML, tự chứa, không CDN).

### `GET /api/config`
```json
{ "ok": true, "config": { "...": "…", "OPENSUBTITLES_API_KEY_SET": true,
  "OPENSUBTITLES_API_KEY_MASK": "abcd••••wxyz" }, "providers": [ … ], "stats": { … } }
```
Secret **không bao giờ** được trả về; chỉ có cờ `*_SET` và bản che `*_MASK`.

### `POST /api/config`
Body JSON, chỉ nhận các khoá đã biết (khoá lạ bị bỏ qua). Trả về cấu hình mới (đã che secret).

```json
{ "ENABLED_PROVIDERS": ["opensubtitles", "local"], "PREFERRED_LANGS": ["vi", "en"],
  "SYNC_MODE": "fast", "LLM_PROVIDER": "groq", "LLM_API_KEY": "gsk_…", "AUDIO_SYNC_ENABLED": false }
```

---

## Sync Lab

Token `t` lấy từ URL phụ đề mà addon đã trả (`/s/<token>/…`), hoặc từ trang `/configure`.

### `GET /synclab?t=TOKEN`
Trang Sync Lab (HTML).

### `GET /api/synclab/session?t=TOKEN`
```json
{
  "ok": true, "videoKey": "h:d41d8cd98f00b204:123456789",
  "title": "Movie.2024.1080p…", "filename": "…mkv",
  "selectedTrackId": "opensubtitles:1234",
  "tracks": [{ "id": "…", "provider": "opensubtitles", "lang": "vi", "langName": "Vietnamese",
               "label": "Movie.2024.1080p.WEB-DL", "offsetMs": -2500, "rate": 1,
               "method": "text", "confidence": 1, "hasOffset": true }],
  "media": { "kind": "local", "path": "/mnt/phim/…mkv", "reason": "open-subtitles hash match" },
  "settings": { "clampMinMs": -180000, "clampMaxMs": 180000, "stepMs": 100,
                "reactionCompensationMs": 300, "allowRate": true, "autoSyncMode": "fast",
                "minApplyConfidence": 0.45, "consensusRequired": true },
  "llm": { "configured": false, "provider": null, "model": "llama-3.1-8b-instant" }
}
```

### `GET /api/synclab/cues?t=&trackId=&fromMs=&toMs=&limit=`
Câu phụ đề theo **thời gian gốc của file** (đúng như Nuvio dùng để căn).

```json
{ "ok": true, "trackId": "…", "total": 48, "fromMs": 14500,
  "cues": [{ "index": 0, "start": 14500, "end": 16935, "text": "…" }] }
```

### `POST /api/synclab/apply`
```json
{ "t": "TOKEN", "trackId": "…", "mode": "tap",
  "videoPositionMs": 15500, "cueStartMs": 14500 }
```
- `mode: "tap"` → `offsetMs = videoPositionMs − cueStartMs − 300` (đúng công thức Nuvio)
- `mode: "offset"` → dùng `offsetMs` (và `rate`) gửi lên
- `mode: "reset"` → xoá offset đã lưu

→ `{ "ok": true, "trackId": "…", "offsetMs": 700, "rate": 1, "method": "manual-tap", "confidence": 1 }`

### `POST /api/synclab/auto`
```json
{ "t": "TOKEN", "trackId": "…", "mode": "fast", "methods": ["text", "llm"] }
```
- `mode: "fast"` — text + LLM; `"full"` — thêm âm thanh
- `methods` (tuỳ chọn) — ghim đúng các tầng muốn chạy, dùng để chẩn đoán

→ `{ "ok": true, "result": { "ok": true, "method": "text", "offsetMs": -2500, "rate": 1,
"confidence": 1, "samples": 96, "detail": { "consensus": { "votes": 2, "share": 1,
"unanimous": true } } } }`

Khác với đường tự động khi Stremio tải, lệnh này **luôn áp dụng** kể cả khi chỉ có một
tham chiếu (vì chính bạn yêu cầu).

### `GET /api/synclab/preview?t=&trackId=`
Trả `text/plain` — phụ đề SRT sau khi áp offset hiện tại (dùng cho nút tải về).

### `POST /api/synclab/media`
```json
{ "t": "TOKEN", "value": "/mnt/phim/Movie.mkv" }
```
`value` có thể là đường dẫn file, URL `http(s)://`, hoặc `magnet:?xt=…` (cần cấu hình debrid).
Đây là cách "gắn" nguồn âm thanh cho nhánh `audio` khi addon không tự tìm được file.

---

## Vận hành

| Endpoint | Nội dung |
| --- | --- |
| `GET /healthz` | `{ ok, version, uptime }` |
| `GET /stats` | số offset/cache/track/sự kiện + cấu hình đã che secret + 20 sự kiện gần nhất |
| `GET /api/sync/state` | 50 sự kiện và 50 offset gần nhất |
| `GET /assets/logo.svg`, `/assets/background.svg` | asset SVG nội bộ (addon không gọi CDN) |
| `GET /docs/<tên>.md` | tài liệu markdown |

## Mã lỗi

| Mã | Khi nào |
| --- | --- |
| 400 | token sai/hết hạn, thiếu tham số, JSON hỏng |
| 403 | đường dẫn tĩnh thoát khỏi thư mục `public/` |
| 404 | track không còn trong cache (chọn lại phụ đề trong Stremio), endpoint lạ |
| 405 | sai method |
| 502 | không tải được phụ đề từ provider |
| 500 | lỗi bất ngờ — luôn trả JSON, không lộ stack trace |
