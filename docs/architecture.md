# Kiến trúc

## 1. Vòng đời một lần chọn phụ đề

```
Stremio                                   nuvio-sync
  │
  ├─ GET /subtitles/movie/tt…/<extra>.json
  │        └─ provider (song song, timeout riêng) → rank/dedupe
  │           lưu track vào SQLite (để căn và tải lại được)
  │        ← [{ id, url: /s/<token>/x.srt, lang }]
  │
  └─ người dùng chọn track → GET /s/<token>/x.srt
           ├─ verify HMAC token → videoKey + trackId
           ├─ có offset đã lưu? → áp + trả từ cache            (~5 ms)
           ├─ chưa? chạy thang đồng bộ, tối đa AUTO_SYNC_BUDGET_MS
           │     text → llm → audio  (dừng khi đủ chắc chắn)
           │     ghi offset + cache, ghi event
           ├─ hết ngân sách → trả file gốc NGAY, đồng bộ tiếp ở nền
           └─ ← file .srt đã viết lại timestamp + header x-nuvio-sync-*
```

Điểm mấu chốt: **Stremio không cho addon chỉnh độ trễ của player**, nên offset phải được
áp lên chính file. Đổi lại, addon sửa được cả `rate` (drift) và việc đồng bộ chỉ xảy ra
một lần cho mỗi (video, track) nhờ cache.

## 2. Ranh giới module

| Module | Trách nhiệm | Hợp đồng |
| --- | --- | --- |
| `src/contracts.js` | typedef đóng băng + hằng số Nuvio | nguồn sự thật duy nhất |
| `src/addon/pipeline.js` | liệt kê → tải → căn → trả file | `handleSubtitlesRequest`, `serveSubtitle`, `runSyncNow` |
| `src/sync/*` | phân tích, dịch timestamp, ba tầng căn | `syncSubtitle(req) -> SyncResult` |
| `src/providers/*` | nguồn phụ đề (gồm `subsense`) + xếp hạng | `meta`, `search(ctx)`, `resolveDownload(track, ctx)` |
| `src/store/*` | SQLite: offsets, cache, registry track, kv, events | §4 trong contracts |
| `src/media/*` | tìm file/URL của phim, hash, debrid | `resolveMedia({...}) -> {kind, path}` |
| `src/synclab/routes.js` | API cho Sync Lab | §6 trong contracts |
| `src/web/pages.js` | HTML tự chứa | `renderConfigPage`, `renderSyncLabPage`, `escapeHtml` |

Quy tắc: `search()` **không bao giờ ném lỗi** (trả `[]` + log), mọi truy vấn mạng có
timeout, và văn bản phụ đề được coi là dữ liệu không tin cậy.

## 3. Thang đồng bộ và vì sao có ngưỡng

`syncSubtitle()` chạy theo thứ tự rẻ → đắt và **thu thập ứng viên** thay vì dừng ngay:

| Tầng | Chi phí | Tin cậy điển hình | Dùng khi |
| --- | --- | --- | --- |
| `text` | 30–350 ms | 0.4 (1 tham chiếu) – 1.0 (đồng thuận) | luôn thử trước |
| `llm` | ~1–3 s, cần key | 0.4 – 0.9 | khi `text` chưa vượt 0.75 |
| `audio` | ~0.2–3 s + trích PCM | 0.3 – 0.9 | khi chưa vượt 0.8, hoặc khi bị chỉ định |

Ứng viên tốt nhất theo `confidence` thắng. Nếu `confidence < minApplyConfidence` (0.45),
kết quả **không được áp** mà trả về dạng `suggestion` để Sync Lab mời người dùng xác nhận.

Vì sao cần: hai phụ đề lệch nhau 2.5 s thì addon **không thể biết file nào sai**. Sửa sai
là phá hỏng file đang đúng. Nên:

- ≥ 2 tham chiếu đồng ý → đó là sự thật (giống ý tưởng của SubSync);
- hoà phiếu → **không sửa gì**;
- một tham chiếu → đề xuất, người dùng quyết định;
- bằng chứng tuyệt đối (hash file khớp, âm thanh, LLM) → áp dụng.

## 4. Tương quan đường bao (điểm kỹ thuật chính)

Cả nhánh `text` (khi khác ngôn ngữ) và nhánh `audio` đều quy về: *hai tập khoảng "đang có
gì đó xảy ra", cần dịch bao nhiêu để chúng trùng khớp nhất?*

`src/sync/correlate.js` giải bài toán đó bằng hai con trỏ trên danh sách khoảng đã sắp xếp —
O(|A| + |B|) cho mỗi độ trễ, không cần FFT:

- phim 2 giờ ≈ 1500 khoảng hội thoại;
- quét thô ±180 s bước 100 ms = 3601 độ trễ → ≈ 11 triệu phép so sánh, vài chục ms;
- sau đó tinh chỉnh ±100 ms với bước 20 ms.

Điểm khớp dùng Jaccard (`overlap / union`) để không bị thiên vị bởi phụ đề dài/ngắn.
Tin cậy kết hợp **độ nổi của đỉnh** (z so với toàn bộ đường cong) và **điểm khớp tuyệt đối**
— cần cả hai, vì một mask có tính chu kỳ có thể cho z rất cao trên nền điểm kém.

So khớp dòng (`textAlign`) dùng bucket chữ ký 4 ký tự + `lineSimilarity` (Dice bigram ∪
Jaccard token) nên tuyến tính theo số cue, không phải O(n·m) trên file 1500 dòng.

## 5. Lưu trữ

SQLite qua `node:sqlite` (built-in, không cần native build). Bảng:

| Bảng | Khoá | Nội dung |
| --- | --- | --- |
| `offsets` | `video_key, track_id` | offset/rate/method/confidence/source — bản port của `persistTrackPreference()` |
| `subs` | `cache_key` | phụ đề gốc và đã căn (`raw…`, `sync…<offset>|<rate>`), có TTL |
| `tracks` | `id` | registry track đã thấy, để tải lại và làm tham chiếu |
| `kv` | `k` | `video:<key>` (tiêu đề, hash, size), `media:path|url|magnet:<key>`, `filehash:…` |
| `events` | autoincrement | nhật ký mọi lần đồng bộ (method, offset, confidence, thời gian) |

Cache key **bao gồm cả offset và rate**, nên đổi offset là cache tự vô hiệu — không cần
xoá thủ công. Hỏng SQLite thì addon vẫn chạy (mọi hàm store trả `null`/`false` và có log).

## 6. Bảo mật

- **Token**: JSON + HMAC-SHA256 (TOKEN_SECRET sinh tự động ở `data/config.json`), so sánh
  bằng `timingSafeEqual`. Không thể giả `trackId` hay nhét cấu hình vào token người khác.
- **Secret**: `publicConfig()` xoá mọi khoá trong `SECRET_KEYS`, chỉ trả `*_SET`/`*_MASK`.
  Token cấu hình (link chia sẻ) **có** nhúng key của chính bạn — đúng như mọi addon
  Stremio khác; đừng chia sẻ link đó cho người khác.
- **SSRF/tải file**: `resolveTrackUrl` chỉ chấp nhận `http(s)`, `file:`, `sample:`.
- **Đường dẫn tĩnh**: `/assets/*` được chuẩn hoá và kiểm tra vẫn nằm trong `public/`.
- **XSS**: mọi giá trị nội suy đi qua `escapeHtml`/`jsonEmbed` (có test riêng).
- **Dữ liệu không tin cậy**: parser phụ đề, XML Podnapisi, ZIP của SubDL, JSON của LLM đều
  được kiểm tra biên và không bao giờ ném lỗi ra ngoài.

## 7. Cấu hình mặc định đáng chú ý

| Khoá | Mặc định | Ghi chú |
| --- | --- | --- |
| `SYNC_MODE` | `fast` | `off` = chỉ áp offset thủ công |
| `AUTO_SYNC_BUDGET_MS` | 9000 | thời gian tối đa giữ người dùng chờ khi tải phụ đề |
| `BACKGROUND_SYNC` | true | đồng bộ tiếp sau khi đã trả file gốc |
| `PREFERRED_LANGS` | `vi,en` | cũng là thứ tự ưu tiên khi xếp hạng |
| `CACHE_TTL_MS` | 7 ngày | TTL của phụ đề đã cache |
| `AUDIO_SYNC_ENABLED` | false | bật nhánh âm thanh |
| `LLM_ATTEMPTS` | 3 | đúng bằng `AUTO_SYNC_MAX_ATTEMPTS` của Nuvio |
| `MAX_SUBTITLES` | 40 | số track trả về Stremio |

## 8. Những gì chưa làm

- **SubSource**: endpoint công khai không ổn định, không viết provider riêng — nhưng đã có
  gián tiếp qua provider `subsense`. Thêm provider mới chỉ cần một file trong
  `src/providers/` theo hợp đồng §2 và đăng ký trong `PROVIDERS`.
- **Whisper cục bộ**: nhánh `audio` hiện dùng VAD năng lượng. Muốn căn cả khi phụ đề lệch
  > ±180 s hoặc khi audio gần như không có khoảng lặng, cần speech-to-text
  (`faster-whisper`) — chỗ nối đã sẵn: thêm một backend mới trong `audioAlign.js` theo
  đúng chữ ký `{ok, offsetMs, rate, detail}`.
- **OCR track built-in (PGS/VobSub)**: Nuvio TV dùng ML Kit để OCR khi không có track text.
  Addon không truy cập được track built-in, nên bỏ qua.
- **`rate` từ nhánh âm thanh**: hiện chỉ trả `rate = 1` (tương quan một tham số). Drift chỉ
  được phát hiện ở nhánh `text` khi có ≥ 2 anchor rải đều file.
