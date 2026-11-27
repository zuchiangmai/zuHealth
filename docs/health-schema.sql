-- 個人健康數據庫 schema（SQLite >= 3.37，需 STRICT 與 FTS5 trigram）
-- 一個數據庫文件 = 一個人。打開時執行：
-- Personal health database schema (SQLite >= 3.37, needs STRICT and FTS5 trigram).
-- One database file = one person. Run on opening:
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;   -- 不保存在文件中，每個連接都要執行
-- (foreign_keys isn't stored in the file: every connection runs it)
--
-- 字段說明格式：
--   意圖   為什麼有這個字段、為什麼是這個類型 / 可空性 / 鍵
--   引用   → 本字段指向哪裡
--   被引用 ← 哪些表的哪些字段指向本字段
-- 引用種類：[FK] 外鍵約束；[邏輯] 無約束，由唯一寫入者保證；[JSON] 存在 JSON 字段內；[文件] 指向 blobs/ 目錄
-- 所有讀取方經 v_observation / v_daily 讀取，視圖中的使用不重複列出。
--
-- How fields are described:
--   Intent         why the field exists, why this type / nullability / key
--   Refers to      → where this field points
--   Referenced by  ← which fields of which tables point here
-- Kinds of reference: [FK] foreign key constraint; [logical] no constraint, kept by the single writer;
--   [JSON] held in a JSON field; [file] points into the blobs/ directory
-- Every reader reads through v_observation / v_daily; uses in the views aren't listed again.

-- ===================================================================
-- metric：指標目錄。每種「量」一行。所有值在寫入時已換算到 unit。
-- metric: the catalogue of measures, one row per kind of quantity. Every value is converted to `unit` when written.
-- ===================================================================
CREATE TABLE metric (
  -- 意圖：本地整數身份，使觀測每行只存 1–2 字節，而非字符串代碼
  -- 引用：無
  -- 被引用：← metric_alias.metric_id [FK]；observation.metric_id [FK]；correction.metric_id [邏輯]；
  --          daily.metric_id [邏輯]；import.meta.span 的鍵 [JSON]
  -- Intent: local integer identity, so an observation row stores 1-2 bytes, not a string code
  -- Refers to: nothing
  -- Referenced by: ← metric_alias.metric_id [FK]; observation.metric_id [FK]; correction.metric_id [logical];
  --          daily.metric_id [logical]; the keys of import.meta.span [JSON]
  id    INTEGER PRIMARY KEY,
  -- 意圖：跨設備的全局身份（兩台設備的 id 不同）。帶命名空間：'loinc:2345-7' | 'x:room_co2' | 'user:<uuid>'
  -- 引用：無（外部標準代碼，如 LOINC）
  -- 被引用：無（同步時用它把對端的 metric_id 翻譯成本地 id）
  -- Intent: global identity across devices (two devices' ids differ). Namespaced: 'loinc:2345-7' | 'x:room_co2' | 'user:<uuid>'
  -- Refers to: nothing (an external standard code, such as LOINC)
  -- Referenced by: nothing (sync uses it to translate the other side's metric_id into a local id)
  code  TEXT    NOT NULL UNIQUE,
  -- 意圖：顯示名兜底，用戶自建指標沒有別的名字；多語言由界面層處理
  -- 引用：無
  -- 被引用：無
  -- Intent: fallback display name (a measure the user made has no other); languages are the UI's job
  -- Refers to: nothing
  -- Referenced by: nothing
  name  TEXT    NOT NULL,
  -- 意圖：規範 UCUM 單位，每個指標只有一個，寫入時換算到它，查詢永不換算；無單位為 '' 而非 NULL
  -- 引用：無
  -- 被引用：無（寫入時由換算步驟讀取，與 metric_alias.unit 的印刷單位不同）
  -- Intent: the canonical UCUM unit, one per measure; values are converted to it on write, never on query;
  --       no unit is '' rather than NULL
  -- Refers to: nothing
  -- Referenced by: nothing (read by the conversion step on write; not the printed unit of metric_alias.unit)
  unit  TEXT    NOT NULL,
  -- 意圖：聚合語義，決定日歸屬、daily 的算法、value 的合法類型與 NULL 含義：
  --       instant 均值極值 | cumulative 求和 | interval 時長並集 | level 按時長加權 | none 不聚合（文本或 blob 指針）
  -- 引用：無
  -- 被引用：無（daily 重建時讀取；擦除時據 agg='none' 找出指向 blob 文件的 observation.value）
  -- Intent: aggregation semantics; decides the day a value belongs to, how daily is computed, the valid value types
  --       and what NULL means: instant mean and extremes | cumulative sum | interval union of durations |
  --       level time-weighted | none not aggregated (text or blob pointer)
  -- Refers to: nothing
  -- Referenced by: nothing (read when daily is rebuilt; on erasing, agg='none' finds the observation.value that
  --          point at blob files)
  agg   TEXT    NOT NULL CHECK (agg IN ('instant','cumulative','interval','level','none'))
) STRICT;

-- ===================================================================
-- metric_alias：別名。OCR 印刷名 / 廠商字段名 → 指標。一個 (別名, 印刷單位) 只指向一個指標。
-- metric_alias: aliases. A name printed on a report (OCR) / a vendor's field name → a measure.
-- One (alias, printed unit) points at one measure only.
-- ===================================================================
CREATE TABLE metric_alias (
  -- 意圖：查找鍵，存折疊後形式（大小寫、全半形、空白）；套組下的項目帶前綴，如 '尿常規/葡萄糖'，先試帶前綴再試不帶
  -- 引用：無
  -- 被引用：無
  -- Intent: the lookup key, stored folded (case, full/half width, whitespace); items of a panel carry a prefix,
  --       such as '尿常規/葡萄糖' (urinalysis/glucose): tried with the prefix first, then without
  -- Refers to: nothing
  -- Referenced by: nothing
  alias     TEXT    NOT NULL,
  -- 意圖：印刷單位（已折疊），無單位為 ''。名稱與單位都對上才自動映射，避免尿糖混入血糖曲線
  -- 引用：無
  -- 被引用：無
  -- Intent: the printed unit (folded), '' for none. Mapped automatically only when name and unit both match,
  --       so urine glucose never joins the blood glucose curve
  -- Refers to: nothing
  -- Referenced by: nothing
  unit      TEXT    NOT NULL,
  -- 意圖：映射目標
  -- 引用：→ metric.id [FK]（仍有別名指向的指標不能刪除）
  -- 被引用：無
  -- Intent: the measure it maps to
  -- Refers to: → metric.id [FK] (a measure an alias still points at can't be deleted)
  -- Referenced by: nothing
  metric_id INTEGER NOT NULL REFERENCES metric,
  PRIMARY KEY (alias, unit)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- source：來源。一個會產生數據的物理或邏輯端點（一塊手錶、一個 HA 實體、一家醫院、一個算法）。
-- source: where data comes from. One physical or logical end that produces data (a watch, a Home Assistant
-- entity, a hospital, an algorithm).
-- ===================================================================
CREATE TABLE source (
  -- 意圖：本地整數身份，觀測每行 1 字節
  -- 引用：無
  -- 被引用：← import.source_id [FK]；observation.source_id [FK]；correction.source_id [邏輯]；daily.source_id [邏輯]
  -- Intent: local integer identity, 1 byte per observation row
  -- Refers to: nothing
  -- Referenced by: ← import.source_id [FK]; observation.source_id [FK]; correction.source_id [logical];
  --          daily.source_id [logical]
  id          INTEGER PRIMARY KEY,
  -- 意圖：由哪段接入代碼負責（刷新、斷開、重新解碼）；與 external_id 組成全局身份
  --       'manual' | 'ocr' | 'healthkit' | 'apple_export' | 'dexcom' | 'home_assistant' | 'derived' ...
  -- 引用：無
  -- 被引用：無
  -- Intent: which connector code is in charge (refresh, disconnect, decode again); with external_id, the global
  --       identity: 'manual' | 'ocr' | 'healthkit' | 'apple_export' | 'dexcom' | 'home_assistant' | 'derived' ...
  -- Refers to: nothing
  -- Referenced by: nothing
  connector   TEXT    NOT NULL,
  -- 意圖：廠商側標識（設備序列號、'<HA 實例>/<entity_id>'、機構名、'<算法>@<版本>'），
  --       重連或換電腦後同一設備仍是同一來源；manual 為 ''
  -- 引用：無（指向外部系統中的對象）
  -- 被引用：無（同步時與 connector 一起把對端的 source_id 翻譯成本地 id）
  -- Intent: the vendor's identifier (a device serial, '<HA instance>/<entity_id>', an institution's name,
  --       '<algorithm>@<version>'), so a device reconnected or moved to another computer is still the same
  --       source; '' for manual
  -- Refers to: nothing (an object in an outside system)
  -- Referenced by: nothing (with connector, sync translates the other side's source_id into a local id)
  external_id TEXT    NOT NULL,
  -- 意圖：顯示名，用戶可改，不參與身份
  -- 引用：無
  -- 被引用：無
  -- Intent: display name, the user's to change; no part of the identity
  -- Refers to: nothing
  -- Referenced by: nothing
  name        TEXT    NOT NULL,
  -- 意圖：同日多來源時的選舉順序，小者勝；改了立即在 v_daily 生效，無需重算
  -- 引用：無
  -- 被引用：無（v_daily 讀取）
  -- Intent: the order of election when several sources cover a day, the smaller wins; a change takes effect in
  --       v_daily at once, nothing to recompute
  -- Refers to: nothing
  -- Referenced by: nothing (read by v_daily)
  priority    INTEGER NOT NULL,
  -- 意圖：各接入方式互不相同的屬性（房間、型號、算法參數、增量同步游標）。憑證不放這裡，放系統 Keychain
  -- 引用：無
  -- 被引用：無
  -- Intent: what differs from one way in to another (room, model, algorithm parameters, incremental sync cursor).
  --       Credentials aren't kept here but in the system keychain
  -- Refers to: nothing
  -- Referenced by: nothing
  meta        TEXT,
  UNIQUE (connector, external_id)
) STRICT;

-- ===================================================================
-- import：導入批次。一次進入系統的數據（一個文件、一次同步、一次手動錄入、一次算法運行）。
-- 承擔溯源、按文件刪除、重新解析、OCR 待審、同步增量、擦除墓碑。
-- import: a batch. One delivery of data into the system (a file, a sync, an entry by hand, an algorithm run).
-- Carries provenance, deleting by file, parsing again, OCR waiting for review, incremental sync, and erase
-- tombstones.
-- ===================================================================
CREATE TABLE import (
  -- 意圖：本地整數身份，兼作同步游標：同步發送 id > 對端游標的導入。
  --       review→done（OCR 確認）、→erased 時改取 max(id)+1，讓變化排到游標之後；此時無行引用它，有則外鍵拒絕
  -- 引用：無
  -- 被引用：← observation.import_id [FK]；genotype.import_id [FK]；report_text.rowid [邏輯]
  -- Intent: local integer identity, also the sync cursor: sync sends the imports with an id above the other
  --       side's cursor. review→done (OCR confirmed) and →erased take max(id)+1, so the change sorts after the
  --       cursor; no row refers to it then (if one did, the foreign key would refuse)
  -- Refers to: nothing
  -- Referenced by: ← observation.import_id [FK]; genotype.import_id [FK]; report_text.rowid [logical]
  id         INTEGER PRIMARY KEY,
  -- 意圖：UUIDv7 跨設備身份，避免兩端各自建的批次撞號；按時間有序，自帶創建時間；
  --       觀測衝突時 uid 大者勝，各設備結果與到達順序無關
  -- 引用：無
  -- 被引用：← import.meta.inputs [JSON]（派生導入記錄輸入用 uid，不用會被改號的 id）
  -- Intent: UUIDv7 identity across devices, so batches made on two sides never collide; time-ordered, carrying
  --       its creation time; on a conflicting observation the larger uid wins, so every device ends the same
  --       whatever the order things arrive in
  -- Refers to: nothing
  -- Referenced by: ← import.meta.inputs [JSON] (a derived import records its inputs by uid, not by an id
  --          that may be renumbered)
  uid        TEXT    NOT NULL UNIQUE,
  -- 意圖：交付這批數據的來源（機構、設備、導出通道）。只有全文或只有基因型的導入，靠它說明出處；斷開來源時據此找批次
  -- 引用：→ source.id [FK]
  -- 被引用：無
  -- Intent: the source that delivered this batch (institution, device, export channel). An import of full text
  --       or genotypes only says where it came from by this; disconnecting a source finds its batches by it
  -- Refers to: → source.id [FK]
  -- Referenced by: nothing
  source_id  INTEGER NOT NULL REFERENCES source,
  -- 意圖：'名稱@版本'，解析器修 bug 後找出需要重解析的批次：'apple-export@3' | 'ocr-ppv5@1' | 'manual' | 'eeg-alpha@2'
  -- 引用：無（指向代碼中的解析器）
  -- 被引用：無
  -- Intent: 'name@version', to find the batches to parse again once a parser's bug is fixed:
  --       'apple-export@3' | 'ocr-ppv5@1' | 'manual' | 'eeg-alpha@2'
  -- Refers to: nothing (a parser in the code)
  -- Referenced by: nothing
  parser     TEXT    NOT NULL,
  -- 意圖：原始文件的 sha256，可回看報告、換參考基因組重解析、重新解碼廠商數據；無原文件（手動、HA）為 NULL。
  --       部分唯一索引保證同一文件只導入一次，否則兩個批次爭奪行歸屬，按文件刪除會刪錯
  -- 引用：→ blobs/<sha256> [文件]
  -- 被引用：無（刪除文件前與 observation.value 一起做引用檢查）
  -- Intent: sha256 of the original file, to look at the report again, parse again on another reference genome,
  --       decode a vendor's data again; NULL when there's no file (manual, HA). A partial unique index keeps a
  --       file to one import: otherwise two batches would fight over rows, and deleting by file would delete
  --       the wrong ones
  -- Refers to: → blobs/<sha256> [file]
  -- Referenced by: nothing (checked for references together with observation.value before a file is deleted)
  blob       TEXT,
  -- 意圖：批次狀態。running 識別崩潰殘留；review 是 OCR 待審隊列；erased 是擦除後保留的同步墓碑
  -- 引用：無
  -- 被引用：無
  -- Intent: the batch's state. running spots what a crash left; review is the OCR queue waiting for review;
  --       erased is the sync tombstone kept after erasing
  -- Refers to: nothing
  -- Referenced by: nothing
  status     TEXT    NOT NULL CHECK (status IN ('running','review','done','failed','erased')),
  -- 意圖：只在批次粒度出現、因批次而異的事實（JSON）：
  --       span   {metric_id: [最早, 最晚 start_ms]}，按導入找行；與所寫的那批行同一事務更新，崩潰後也能清理
  --       candidates（OCR 待審候選）、build（基因組參考版本）、inputs（派生輸入）、拒收計數、錯誤
  -- 引用：→ metric.id（span 的鍵）[JSON]；→ import.uid（inputs）[JSON]
  -- 被引用：無
  -- Intent: facts that exist per batch only and differ between batches (JSON):
  --       span   {metric_id: [earliest, latest start_ms]}, to find an import's rows; updated in the same
  --              transaction as the rows written, so a crash can still be cleaned up
  --       candidates (OCR candidates waiting for review), build (genome reference), inputs (derived inputs),
  --       counts refused, errors
  -- Refers to: → metric.id (the keys of span) [JSON]; → import.uid (inputs) [JSON]
  -- Referenced by: nothing
  meta       TEXT
) STRICT;
CREATE UNIQUE INDEX import_blob ON import (blob) WHERE blob IS NOT NULL;

-- ===================================================================
-- observation：觀測（核心表）。所有帶時間的數據。自然鍵 (metric_id, start_ms, source_id) 即身份，重複導入冪等。
-- 不建 import_id 索引（佔每行 18 字節，36%）。按導入找行 = 按 import.meta.span 做主鍵範圍掃描再過濾 import_id。
-- observation: observations (the core table). All data with a time. The natural key (metric_id, start_ms,
-- source_id) is the identity, so importing again changes nothing.
-- No index on import_id (18 bytes per row, 36%). An import's rows = a primary-key range scan by
-- import.meta.span, filtered on import_id.
-- ===================================================================
CREATE TABLE observation (
  -- 意圖：測的是什麼；主鍵首位，按指標查詢是連續頁
  -- 引用：→ metric.id [FK]
  -- 被引用：← correction.metric_id [邏輯，自然鍵第 1 位]；daily.metric_id（由此聚合而來）[邏輯]
  -- Intent: what was measured; first in the primary key, so a measure's rows are contiguous pages
  -- Refers to: → metric.id [FK]
  -- Referenced by: ← correction.metric_id [logical, natural key #1]; daily.metric_id (aggregated from it) [logical]
  metric_id INTEGER NOT NULL REFERENCES metric,
  -- 意圖：UTC 毫秒；整數無時區與格式歧義
  -- 引用：無
  -- 被引用：← correction.start_ms [邏輯，自然鍵第 2 位]；daily.day（與 tz_min 一起推出）[邏輯]；import.meta.span 的範圍 [JSON]
  -- Intent: UTC milliseconds; an integer has no time zone or format ambiguity
  -- Refers to: nothing
  -- Referenced by: ← correction.start_ms [logical, natural key #2]; daily.day (derived with tz_min) [logical];
  --          the ranges of import.meta.span [JSON]
  start_ms  INTEGER NOT NULL,
  -- 意圖：主鍵第 3 位，同一時刻不同來源可並存，選舉才有可能
  -- 引用：→ source.id [FK]
  -- 被引用：← correction.source_id [邏輯，自然鍵第 3 位]；daily.source_id（由此聚合而來）[邏輯]
  -- Intent: third in the primary key, so different sources can coexist at the same instant and be elected
  -- Refers to: → source.id [FK]
  -- Referenced by: ← correction.source_id [logical, natural key #3]; daily.source_id (aggregated from it) [logical]
  source_id INTEGER NOT NULL REFERENCES source,
  -- 意圖：步數段、睡眠區間、腦電記錄的結束時刻，區間並集靠它；NULL = 瞬時點，佔 0 字節
  -- 引用：無
  -- 被引用：← daily.day（interval 按結束時刻歸日）[邏輯]
  -- Intent: the end of a step segment, a sleep interval, an EEG recording; the union of intervals needs it;
  --       NULL = an instant, taking 0 bytes
  -- Refers to: nothing
  -- Referenced by: ← daily.day (an interval belongs to the day it ends) [logical]
  end_ms    INTEGER,
  -- 意圖：測量當地的 UTC 偏移（分鐘），出差時也能算出「這是哪一天」；IANA 時區名用不上
  -- 引用：無
  -- 被引用：← daily.day（與 start_ms / end_ms 一起推出）[邏輯]
  -- Intent: the UTC offset (minutes) where it was measured, so 'which day was it' holds while travelling; an IANA
  --       zone name isn't needed
  -- Refers to: nothing
  -- Referenced by: ← daily.day (derived with start_ms / end_ms) [logical]
  tz_min    INTEGER NOT NULL,
  -- 意圖：值。動態類型：數字為整數或浮點，類別或文本為 TEXT；含義與 NULL 語義由 metric.agg 決定；
  --       刪失值（<0.5）存邊界數字，比較符在 detail
  -- 引用：→ blobs/<sha256> [文件]（僅 agg='none' 的波形塊指針）
  -- 被引用：← daily.n / sum / min / max / seconds（由此聚合而來）[邏輯]
  -- Intent: the value. Dynamically typed: a number is an integer or a float, a category or text is TEXT; its
  --       meaning and what NULL means follow metric.agg; a censored value (<0.5) stores the bound, its
  --       comparator is in detail
  -- Refers to: → blobs/<sha256> [file] (only the waveform chunk pointer of agg='none')
  -- Referenced by: ← daily.n / sum / min / max / seconds (aggregated from it) [logical]
  value     ANY CHECK (typeof(value) IN ('integer','real','text','null')),
  -- 意圖：本行由哪次導入交付，用於按文件刪除、同步增量、OCR 值回溯原圖；
  --       衝突時轉給 uid 較大（較新）的導入，所以一行屬於最近一次交付它的文件
  -- 引用：→ import.id [FK]
  -- 被引用：無
  -- Intent: the import that delivered this row, for deleting by file, incremental sync, tracing an OCR value
  --       back to its picture; on a conflict it passes to the import with the larger (newer) uid, so a row
  --       belongs to the file that delivered it last
  -- Refers to: → import.id [FK]
  -- Referenced by: nothing
  import_id INTEGER NOT NULL REFERENCES import,
  -- 意圖：少數需要保留證據的行才填的 JSON：印刷原文、參考範圍、比較符、精度（如 'day'）、框選坐標、通道與採樣率；
  --       設備樣本為 NULL，不佔空間
  -- 引用：無
  -- 被引用：無（daily 重建時據 detail.comparator 跳過刪失值）
  -- Intent: JSON filled only for the few rows that keep evidence: the printed text, the reference range, the
  --       comparator, the precision (such as 'day'), box coordinates, channels and sample rate; NULL for device
  --       samples, taking no space
  -- Refers to: nothing
  -- Referenced by: nothing (daily's rebuild skips censored values by detail.comparator)
  detail    TEXT,
  PRIMARY KEY (metric_id, start_ms, source_id),
  CHECK (end_ms IS NULL OR end_ms >= start_ms)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- correction：用戶更正層。用戶對外部來源數據的修改，從不改寫 observation，來源重推也覆蓋不掉。每個點只留最新一條。
-- 不加外鍵：同步時更正可能先於觀測到達；觀測被擦除後，孤立的更正無害。
-- correction: the user's corrections. A user's change to data from an outside source; observation is never
-- rewritten, and the source pushing again can't override it. Only the latest per point is kept.
-- No foreign keys: in sync a correction may arrive before its observation; once the observation is erased,
-- an orphaned correction does no harm.
-- ===================================================================
CREATE TABLE correction (
  -- 意圖：與 start_ms、source_id 一起指向被更正的觀測，用自然鍵而非行 ID，同步後依然有效
  -- 引用：→ observation.metric_id [邏輯]，即 → metric.id
  -- 被引用：無
  -- Intent: with start_ms and source_id, points at the corrected observation, by the natural key rather than a
  --       row id, so it still holds after sync
  -- Refers to: → observation.metric_id [logical], that is → metric.id
  -- Referenced by: nothing
  metric_id INTEGER NOT NULL,
  -- 意圖：同上，被更正觀測的來源
  -- 引用：→ observation.source_id [邏輯]，即 → source.id
  -- 被引用：無
  -- Intent: as above, the corrected observation's source
  -- Refers to: → observation.source_id [logical], that is → source.id
  -- Referenced by: nothing
  source_id INTEGER NOT NULL,
  -- 意圖：同上，被更正觀測的時刻
  -- 引用：→ observation.start_ms [邏輯]
  -- 被引用：無
  -- Intent: as above, the corrected observation's instant
  -- Refers to: → observation.start_ms [logical]
  -- Referenced by: nothing
  start_ms  INTEGER NOT NULL,
  -- 意圖：HLC 時間戳；兩台設備的更正合併時 at 大者勝；at 相同時比 value，大者勝（NULL 最小，所以有值的更正勝過同 at 的刪除；次序用 SQLite 的全序：NULL < 數字按數值 < 文本按 UTF-8 字節，在 SQL 裡比），與到達順序無關
  -- 引用：無
  -- 被引用：無
  -- Intent: an HLC timestamp; merging two devices' corrections, the larger at wins; with equal at, the larger
  --       value wins (NULL smallest, so a correction with a value beats a deletion at the same at; the order is
  --       SQLite's total order: NULL < numbers by value < text by UTF-8 bytes, compared in SQL), whatever the
  --       order of arrival
  -- Refers to: nothing
  -- Referenced by: nothing
  at        INTEGER NOT NULL,
  -- 意圖：更正後的值；NULL = 刪除該觀測
  -- 引用：→ 取代 observation.value [邏輯]
  -- 被引用：無
  -- Intent: the corrected value; NULL = the observation is deleted
  -- Refers to: → takes the place of observation.value [logical]
  -- Referenced by: nothing
  value     ANY CHECK (typeof(value) IN ('integer','real','text','null')),
  PRIMARY KEY (metric_id, source_id, start_ms)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- genotype：基因型。按位點而非時間組織，不屬於觀測。
-- genotype: genotypes. Organised by locus, not by time; not observations.
-- ===================================================================
CREATE TABLE genotype (
  -- 意圖：來自哪次上傳；多次上傳（不同廠商、不同版本）互不混淆，可按文件刪除；主鍵首位，按導入刪除無需索引
  -- 引用：→ import.id [FK]（參考基因組版本在 import.meta.build）
  -- 被引用：無
  -- Intent: which upload it came from; several uploads (vendors, versions) never mix and can be deleted by file;
  --       first in the primary key, so deleting by import needs no index
  -- Refers to: → import.id [FK] (the reference genome's version is in import.meta.build)
  -- Referenced by: nothing
  import_id INTEGER NOT NULL REFERENCES import,
  -- 意圖：染色體；TEXT 因為有 'X'、'MT' 和長 contig 名；沒有 rsID 的位點靠它和 pos 定位
  -- 引用：無
  -- 被引用：無
  -- Intent: chromosome; TEXT because of 'X', 'MT' and long contig names; a locus without an rsID is found by it
  --       and pos
  -- Refers to: nothing
  -- Referenced by: nothing
  chrom     TEXT    NOT NULL,
  -- 意圖：位置；坐標系由所屬導入的 build 決定
  -- 引用：無（坐標系見 import.meta.build）
  -- 被引用：無
  -- Intent: position; its coordinate system is the build of the import it belongs to
  -- Refers to: nothing (the coordinate system is in import.meta.build)
  -- Referenced by: nothing
  pos       INTEGER NOT NULL,
  -- 意圖：rs 號的數字部分（省空間），支持最常用的「查 rs4680」；VCF 中沒有 ID 的位點為 NULL，建部分索引
  -- 引用：無（指向外部 dbSNP）
  -- 被引用：無
  -- Intent: the number of the rs id (saves space), for the commonest 'look up rs4680'; NULL for a VCF locus with
  --       no ID; a partial index is built
  -- Refers to: nothing (dbSNP, outside)
  -- Referenced by: nothing
  rsid      INTEGER,
  -- 意圖：直接存等位基因字母，不依賴 REF/ALT 即可讀出：'AG' | 'TT' | '--'
  -- 引用：無
  -- 被引用：無
  -- Intent: the alleles' letters stored as they are, readable without REF/ALT: 'AG' | 'TT' | '--'
  -- Refers to: nothing
  -- Referenced by: nothing
  genotype  TEXT    NOT NULL,
  PRIMARY KEY (import_id, chrom, pos)
) STRICT, WITHOUT ROWID;
CREATE INDEX genotype_rsid ON genotype (rsid, import_id) WHERE rsid IS NOT NULL;

-- ===================================================================
-- daily：日聚合。可隨時刪除重建的派生表，只關乎性能，不關乎正確性。每個 (指標, 本地日, 來源) 一行。
-- 不加外鍵：派生數據，重建時整體替換。
-- daily: daily aggregates. A derived table that can be dropped and rebuilt at any time: it's about speed, not
-- correctness. One row per (measure, local day, source).
-- No foreign keys: derived data, replaced whole when rebuilt.
-- ===================================================================
CREATE TABLE daily (
  -- 意圖：聚合的是哪個指標
  -- 引用：→ metric.id [邏輯]（聚合自 observation.metric_id）
  -- 被引用：無
  -- Intent: the measure aggregated
  -- Refers to: → metric.id [logical] (aggregated from observation.metric_id)
  -- Referenced by: nothing
  metric_id INTEGER NOT NULL,
  -- 意圖：本地日 'YYYY-MM-DD'。instant / cumulative 按 start_ms + tz_min；interval 按結束時刻；level 按時間切分
  -- 引用：→ 由 observation.start_ms / end_ms / tz_min 推出 [邏輯]
  -- 被引用：無
  -- Intent: the local day 'YYYY-MM-DD'. instant / cumulative by start_ms + tz_min; interval by its end; level
  --       split by time
  -- Refers to: → derived from observation.start_ms / end_ms / tz_min [logical]
  -- Referenced by: nothing
  day       TEXT    NOT NULL,
  -- 意圖：每個來源各一行，選舉才能在讀取時進行（v_daily），調整優先級無需重算
  -- 引用：→ source.id [邏輯]（聚合自 observation.source_id）
  -- 被引用：無
  -- Intent: one row per source, so the election happens when reading (v_daily) and a priority change needs no
  --       recompute
  -- Refers to: → source.id [logical] (aggregated from observation.source_id)
  -- Referenced by: nothing
  source_id INTEGER NOT NULL,
  -- 意圖：樣本數；求均值，判斷數據是否稀疏
  -- 引用：→ 統計自 observation 的行數 [邏輯]
  -- 被引用：無
  -- Intent: the number of samples; for the mean, and to tell sparse data
  -- Refers to: → the count of observation rows [logical]
  -- Referenced by: nothing
  n         INTEGER NOT NULL,
  -- 意圖：instant / cumulative 為值之和（均值 = sum / n）；level 為「值 × 秒」的積分（均值 = sum / seconds）
  -- 引用：→ 聚合自 observation.value [邏輯]
  -- 被引用：無
  -- Intent: instant / cumulative: the sum of values (mean = sum / n); level: the integral of value × seconds
  --       (mean = sum / seconds)
  -- Refers to: → aggregated from observation.value [logical]
  -- Referenced by: nothing
  sum       REAL,
  -- 意圖：範圍圖的下界；是否有意義由 agg 決定
  -- 引用：→ 聚合自 observation.value [邏輯]
  -- 被引用：無
  -- Intent: the lower bound of a range chart; whether it means anything follows agg
  -- Refers to: → aggregated from observation.value [logical]
  -- Referenced by: nothing
  min       REAL,
  -- 意圖：範圍圖的上界；是否有意義由 agg 決定
  -- 引用：→ 聚合自 observation.value [邏輯]
  -- 被引用：無
  -- Intent: the upper bound of a range chart; whether it means anything follows agg
  -- Refers to: → aggregated from observation.value [logical]
  -- Referenced by: nothing
  max       REAL,
  -- 意圖：interval 為區間並集時長（睡眠時長）；level 為有讀數的時長（斷線不計）
  -- 引用：→ 由 observation.start_ms / end_ms 計算 [邏輯]
  -- 被引用：無
  -- Intent: interval: the length of the union of intervals (sleep duration); level: the time with readings
  --       (gaps not counted)
  -- Refers to: → computed from observation.start_ms / end_ms [logical]
  -- Referenced by: nothing
  seconds   INTEGER,
  PRIMARY KEY (metric_id, day, source_id)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- report_text：報告全文（FTS5）。醫生結論、影像描述等無法結構化的敘述文字；重新 OCR 既昂貴又不確定，所以存下。
-- FTS5 不允許在列定義中寫註釋，字段說明寫在這裡：
--   rowid  意圖：= 所屬導入，一個導入最多一份全文；OCR 確認時（導入改號之後）寫入
--          引用：→ import.id [邏輯]    被引用：無
--   text   意圖：提取出的全文；trigram 分詞器讓「未見異常」這類中文子串可搜（默認 unicode61 不切中文）
--          引用：無                    被引用：無
-- report_text: a report's full text (FTS5). A doctor's conclusion, an imaging description and other prose that
-- can't be structured; reading it again by OCR is costly and uncertain, so it's kept.
-- FTS5 allows no comments in its column definitions, so the fields are described here:
--   rowid  Intent: = its import, one full text per import at most; written when the OCR is confirmed (after
--          the import is renumbered)
--          Refers to: → import.id [logical]    Referenced by: nothing
--   text   Intent: the extracted full text; the trigram tokenizer makes Chinese substrings such as '未見異常'
--          (no abnormality seen) searchable (the default unicode61 doesn't split Chinese)
--          Refers to: nothing                  Referenced by: nothing
-- ===================================================================
CREATE VIRTUAL TABLE report_text USING fts5 (text, tokenize = 'trigram');

-- 唯一讀取面：已套用更正、已排除被刪除的觀測。每個點最多一條更正，只是一個主鍵 LEFT JOIN。
-- corrected 列：1 = 值來自 correction，界面可提示「已更正」並查看原值
-- The one reading surface: corrections applied, deleted observations left out. At most one correction per point,
-- so it's a single primary-key LEFT JOIN.
-- The corrected column: 1 = the value comes from correction; the UI can say 'corrected' and show the original
CREATE VIEW v_observation AS
SELECT o.metric_id, o.start_ms, o.source_id, o.end_ms, o.tz_min,
       CASE WHEN c.at IS NULL THEN o.value ELSE c.value END AS value,
       o.import_id, o.detail, (c.at IS NOT NULL) AS corrected
  FROM observation o
  LEFT JOIN correction c
         ON c.metric_id = o.metric_id AND c.source_id = o.source_id AND c.start_ms = o.start_ms
 WHERE c.at IS NULL OR c.value IS NOT NULL;

-- 每日選舉：每個 (指標, 日) 只取一個來源；優先級相同時按 source_id，結果確定。
-- The daily election: one source per (measure, day); equal priorities go by source_id, so the result is fixed.
CREATE VIEW v_daily AS
SELECT metric_id, day, source_id, n, sum, min, max, seconds
  FROM (SELECT d.*, row_number() OVER (PARTITION BY d.metric_id, d.day
                                       ORDER BY s.priority, d.source_id) AS rk
          FROM daily d JOIN source s ON s.id = d.source_id)
 WHERE rk = 1;
