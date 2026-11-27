-- 個人健康數據庫 schema（SQLite >= 3.37，需 STRICT 與 FTS5 trigram）
-- 一個數據庫文件 = 一個人。打開時執行：
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;   -- 不保存在文件中，每個連接都要執行
--
-- 字段說明格式：
--   意圖   為什麼有這個字段、為什麼是這個類型 / 可空性 / 鍵
--   引用   → 本字段指向哪裡
--   被引用 ← 哪些表的哪些字段指向本字段
-- 引用種類：[FK] 外鍵約束；[邏輯] 無約束，由唯一寫入者保證；[JSON] 存在 JSON 字段內；[文件] 指向 blobs/ 目錄
-- 所有讀取方經 v_observation / v_daily 讀取，視圖中的使用不重複列出。

-- ===================================================================
-- metric：指標目錄。每種「量」一行。所有值在寫入時已換算到 unit。
-- ===================================================================
CREATE TABLE metric (
  -- 意圖：本地整數身份，使觀測每行只存 1–2 字節，而非字符串代碼
  -- 引用：無
  -- 被引用：← metric_alias.metric_id [FK]；observation.metric_id [FK]；correction.metric_id [邏輯]；
  --          daily.metric_id [邏輯]；import.meta.span 的鍵 [JSON]
  id    INTEGER PRIMARY KEY,
  -- 意圖：跨設備的全局身份（兩台設備的 id 不同）。帶命名空間：'loinc:2345-7' | 'x:room_co2' | 'user:<uuid>'
  -- 引用：無（外部標準代碼，如 LOINC）
  -- 被引用：無（同步時用它把對端的 metric_id 翻譯成本地 id）
  code  TEXT    NOT NULL UNIQUE,
  -- 意圖：顯示名兜底，用戶自建指標沒有別的名字；多語言由界面層處理
  -- 引用：無
  -- 被引用：無
  name  TEXT    NOT NULL,
  -- 意圖：規範 UCUM 單位，每個指標只有一個，寫入時換算到它，查詢永不換算；無單位為 '' 而非 NULL
  -- 引用：無
  -- 被引用：無（寫入時由換算步驟讀取，與 metric_alias.unit 的印刷單位不同）
  unit  TEXT    NOT NULL,
  -- 意圖：聚合語義，決定日歸屬、daily 的算法、value 的合法類型與 NULL 含義：
  --       instant 均值極值 | cumulative 求和 | interval 時長並集 | level 按時長加權 | none 不聚合（文本或 blob 指針）
  -- 引用：無
  -- 被引用：無（daily 重建時讀取；擦除時據 agg='none' 找出指向 blob 文件的 observation.value）
  agg   TEXT    NOT NULL CHECK (agg IN ('instant','cumulative','interval','level','none'))
) STRICT;

-- ===================================================================
-- metric_alias：別名。OCR 印刷名 / 廠商字段名 → 指標。一個 (別名, 印刷單位) 只指向一個指標。
-- ===================================================================
CREATE TABLE metric_alias (
  -- 意圖：查找鍵，存折疊後形式（大小寫、全半形、空白）；套組下的項目帶前綴，如 '尿常規/葡萄糖'，先試帶前綴再試不帶
  -- 引用：無
  -- 被引用：無
  alias     TEXT    NOT NULL,
  -- 意圖：印刷單位（已折疊），無單位為 ''。名稱與單位都對上才自動映射，避免尿糖混入血糖曲線
  -- 引用：無
  -- 被引用：無
  unit      TEXT    NOT NULL,
  -- 意圖：映射目標
  -- 引用：→ metric.id [FK]（仍有別名指向的指標不能刪除）
  -- 被引用：無
  metric_id INTEGER NOT NULL REFERENCES metric,
  PRIMARY KEY (alias, unit)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- source：來源。一個會產生數據的物理或邏輯端點（一塊手錶、一個 HA 實體、一家醫院、一個算法）。
-- ===================================================================
CREATE TABLE source (
  -- 意圖：本地整數身份，觀測每行 1 字節
  -- 引用：無
  -- 被引用：← import.source_id [FK]；observation.source_id [FK]；correction.source_id [邏輯]；daily.source_id [邏輯]
  id          INTEGER PRIMARY KEY,
  -- 意圖：由哪段接入代碼負責（刷新、斷開、重新解碼）；與 external_id 組成全局身份
  --       'manual' | 'ocr' | 'healthkit' | 'apple_export' | 'dexcom' | 'home_assistant' | 'derived' ...
  -- 引用：無
  -- 被引用：無
  connector   TEXT    NOT NULL,
  -- 意圖：廠商側標識（設備序列號、'<HA 實例>/<entity_id>'、機構名、'<算法>@<版本>'），
  --       重連或換電腦後同一設備仍是同一來源；manual 為 ''
  -- 引用：無（指向外部系統中的對象）
  -- 被引用：無（同步時與 connector 一起把對端的 source_id 翻譯成本地 id）
  external_id TEXT    NOT NULL,
  -- 意圖：顯示名，用戶可改，不參與身份
  -- 引用：無
  -- 被引用：無
  name        TEXT    NOT NULL,
  -- 意圖：同日多來源時的選舉順序，小者勝；改了立即在 v_daily 生效，無需重算
  -- 引用：無
  -- 被引用：無（v_daily 讀取）
  priority    INTEGER NOT NULL,
  -- 意圖：各接入方式互不相同的屬性（房間、型號、算法參數、增量同步游標）。憑證不放這裡，放系統 Keychain
  -- 引用：無
  -- 被引用：無
  meta        TEXT,
  UNIQUE (connector, external_id)
) STRICT;

-- ===================================================================
-- import：導入批次。一次進入系統的數據（一個文件、一次同步、一次手動錄入、一次算法運行）。
-- 承擔溯源、按文件刪除、重新解析、OCR 待審、同步增量、擦除墓碑。
-- ===================================================================
CREATE TABLE import (
  -- 意圖：本地整數身份，兼作同步游標：同步發送 id > 對端游標的導入。
  --       review→done（OCR 確認）、→erased 時改取 max(id)+1，讓變化排到游標之後；此時無行引用它，有則外鍵拒絕
  -- 引用：無
  -- 被引用：← observation.import_id [FK]；genotype.import_id [FK]；report_text.rowid [邏輯]
  id         INTEGER PRIMARY KEY,
  -- 意圖：UUIDv7 跨設備身份，避免兩端各自建的批次撞號；按時間有序，自帶創建時間；
  --       觀測衝突時 uid 大者勝，各設備結果與到達順序無關
  -- 引用：無
  -- 被引用：← import.meta.inputs [JSON]（派生導入記錄輸入用 uid，不用會被改號的 id）
  uid        TEXT    NOT NULL UNIQUE,
  -- 意圖：交付這批數據的來源（機構、設備、導出通道）。只有全文或只有基因型的導入，靠它說明出處；斷開來源時據此找批次
  -- 引用：→ source.id [FK]
  -- 被引用：無
  source_id  INTEGER NOT NULL REFERENCES source,
  -- 意圖：'名稱@版本'，解析器修 bug 後找出需要重解析的批次：'apple-export@3' | 'ocr-ppv5@1' | 'manual' | 'eeg-alpha@2'
  -- 引用：無（指向代碼中的解析器）
  -- 被引用：無
  parser     TEXT    NOT NULL,
  -- 意圖：原始文件的 sha256，可回看報告、換參考基因組重解析、重新解碼廠商數據；無原文件（手動、HA）為 NULL。
  --       部分唯一索引保證同一文件只導入一次，否則兩個批次爭奪行歸屬，按文件刪除會刪錯
  -- 引用：→ blobs/<sha256> [文件]
  -- 被引用：無（刪除文件前與 observation.value 一起做引用檢查）
  blob       TEXT,
  -- 意圖：批次狀態。running 識別崩潰殘留；review 是 OCR 待審隊列；erased 是擦除後保留的同步墓碑
  -- 引用：無
  -- 被引用：無
  status     TEXT    NOT NULL CHECK (status IN ('running','review','done','failed','erased')),
  -- 意圖：只在批次粒度出現、因批次而異的事實（JSON）：
  --       span   {metric_id: [最早, 最晚 start_ms]}，按導入找行；與所寫的那批行同一事務更新，崩潰後也能清理
  --       candidates（OCR 待審候選）、build（基因組參考版本）、inputs（派生輸入）、拒收計數、錯誤
  -- 引用：→ metric.id（span 的鍵）[JSON]；→ import.uid（inputs）[JSON]
  -- 被引用：無
  meta       TEXT
) STRICT;
CREATE UNIQUE INDEX import_blob ON import (blob) WHERE blob IS NOT NULL;

-- ===================================================================
-- observation：觀測（核心表）。所有帶時間的數據。自然鍵 (metric_id, start_ms, source_id) 即身份，重複導入冪等。
-- 不建 import_id 索引（佔每行 18 字節，36%）。按導入找行 = 按 import.meta.span 做主鍵範圍掃描再過濾 import_id。
-- ===================================================================
CREATE TABLE observation (
  -- 意圖：測的是什麼；主鍵首位，按指標查詢是連續頁
  -- 引用：→ metric.id [FK]
  -- 被引用：← correction.metric_id [邏輯，自然鍵第 1 位]；daily.metric_id（由此聚合而來）[邏輯]
  metric_id INTEGER NOT NULL REFERENCES metric,
  -- 意圖：UTC 毫秒；整數無時區與格式歧義
  -- 引用：無
  -- 被引用：← correction.start_ms [邏輯，自然鍵第 2 位]；daily.day（與 tz_min 一起推出）[邏輯]；import.meta.span 的範圍 [JSON]
  start_ms  INTEGER NOT NULL,
  -- 意圖：主鍵第 3 位，同一時刻不同來源可並存，選舉才有可能
  -- 引用：→ source.id [FK]
  -- 被引用：← correction.source_id [邏輯，自然鍵第 3 位]；daily.source_id（由此聚合而來）[邏輯]
  source_id INTEGER NOT NULL REFERENCES source,
  -- 意圖：步數段、睡眠區間、腦電記錄的結束時刻，區間並集靠它；NULL = 瞬時點，佔 0 字節
  -- 引用：無
  -- 被引用：← daily.day（interval 按結束時刻歸日）[邏輯]
  end_ms    INTEGER,
  -- 意圖：測量當地的 UTC 偏移（分鐘），出差時也能算出「這是哪一天」；IANA 時區名用不上
  -- 引用：無
  -- 被引用：← daily.day（與 start_ms / end_ms 一起推出）[邏輯]
  tz_min    INTEGER NOT NULL,
  -- 意圖：值。動態類型：數字為整數或浮點，類別或文本為 TEXT；含義與 NULL 語義由 metric.agg 決定；
  --       刪失值（<0.5）存邊界數字，比較符在 detail
  -- 引用：→ blobs/<sha256> [文件]（僅 agg='none' 的波形塊指針）
  -- 被引用：← daily.n / sum / min / max / seconds（由此聚合而來）[邏輯]
  value     ANY CHECK (typeof(value) IN ('integer','real','text','null')),
  -- 意圖：本行由哪次導入交付，用於按文件刪除、同步增量、OCR 值回溯原圖；
  --       衝突時轉給 uid 較大（較新）的導入，所以一行屬於最近一次交付它的文件
  -- 引用：→ import.id [FK]
  -- 被引用：無
  import_id INTEGER NOT NULL REFERENCES import,
  -- 意圖：少數需要保留證據的行才填的 JSON：印刷原文、參考範圍、比較符、精度（如 'day'）、框選坐標、通道與採樣率；
  --       設備樣本為 NULL，不佔空間
  -- 引用：無
  -- 被引用：無（daily 重建時據 detail.comparator 跳過刪失值）
  detail    TEXT,
  PRIMARY KEY (metric_id, start_ms, source_id),
  CHECK (end_ms IS NULL OR end_ms >= start_ms)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- correction：用戶更正層。用戶對外部來源數據的修改，從不改寫 observation，來源重推也覆蓋不掉。每個點只留最新一條。
-- 不加外鍵：同步時更正可能先於觀測到達；觀測被擦除後，孤立的更正無害。
-- ===================================================================
CREATE TABLE correction (
  -- 意圖：與 start_ms、source_id 一起指向被更正的觀測，用自然鍵而非行 ID，同步後依然有效
  -- 引用：→ observation.metric_id [邏輯]，即 → metric.id
  -- 被引用：無
  metric_id INTEGER NOT NULL,
  -- 意圖：同上，被更正觀測的來源
  -- 引用：→ observation.source_id [邏輯]，即 → source.id
  -- 被引用：無
  source_id INTEGER NOT NULL,
  -- 意圖：同上，被更正觀測的時刻
  -- 引用：→ observation.start_ms [邏輯]
  -- 被引用：無
  start_ms  INTEGER NOT NULL,
  -- 意圖：HLC 時間戳；兩台設備的更正合併時 at 大者勝；at 相同時比 value，大者勝（NULL 最小，所以有值的更正勝過同 at 的刪除；次序用 SQLite 的全序：NULL < 數字按數值 < 文本按 UTF-8 字節，在 SQL 裡比），與到達順序無關
  -- 引用：無
  -- 被引用：無
  at        INTEGER NOT NULL,
  -- 意圖：更正後的值；NULL = 刪除該觀測
  -- 引用：→ 取代 observation.value [邏輯]
  -- 被引用：無
  value     ANY CHECK (typeof(value) IN ('integer','real','text','null')),
  PRIMARY KEY (metric_id, source_id, start_ms)
) STRICT, WITHOUT ROWID;

-- ===================================================================
-- genotype：基因型。按位點而非時間組織，不屬於觀測。
-- ===================================================================
CREATE TABLE genotype (
  -- 意圖：來自哪次上傳；多次上傳（不同廠商、不同版本）互不混淆，可按文件刪除；主鍵首位，按導入刪除無需索引
  -- 引用：→ import.id [FK]（參考基因組版本在 import.meta.build）
  -- 被引用：無
  import_id INTEGER NOT NULL REFERENCES import,
  -- 意圖：染色體；TEXT 因為有 'X'、'MT' 和長 contig 名；沒有 rsID 的位點靠它和 pos 定位
  -- 引用：無
  -- 被引用：無
  chrom     TEXT    NOT NULL,
  -- 意圖：位置；坐標系由所屬導入的 build 決定
  -- 引用：無（坐標系見 import.meta.build）
  -- 被引用：無
  pos       INTEGER NOT NULL,
  -- 意圖：rs 號的數字部分（省空間），支持最常用的「查 rs4680」；VCF 中沒有 ID 的位點為 NULL，建部分索引
  -- 引用：無（指向外部 dbSNP）
  -- 被引用：無
  rsid      INTEGER,
  -- 意圖：直接存等位基因字母，不依賴 REF/ALT 即可讀出：'AG' | 'TT' | '--'
  -- 引用：無
  -- 被引用：無
  genotype  TEXT    NOT NULL,
  PRIMARY KEY (import_id, chrom, pos)
) STRICT, WITHOUT ROWID;
CREATE INDEX genotype_rsid ON genotype (rsid, import_id) WHERE rsid IS NOT NULL;

-- ===================================================================
-- daily：日聚合。可隨時刪除重建的派生表，只關乎性能，不關乎正確性。每個 (指標, 本地日, 來源) 一行。
-- 不加外鍵：派生數據，重建時整體替換。
-- ===================================================================
CREATE TABLE daily (
  -- 意圖：聚合的是哪個指標
  -- 引用：→ metric.id [邏輯]（聚合自 observation.metric_id）
  -- 被引用：無
  metric_id INTEGER NOT NULL,
  -- 意圖：本地日 'YYYY-MM-DD'。instant / cumulative 按 start_ms + tz_min；interval 按結束時刻；level 按時間切分
  -- 引用：→ 由 observation.start_ms / end_ms / tz_min 推出 [邏輯]
  -- 被引用：無
  day       TEXT    NOT NULL,
  -- 意圖：每個來源各一行，選舉才能在讀取時進行（v_daily），調整優先級無需重算
  -- 引用：→ source.id [邏輯]（聚合自 observation.source_id）
  -- 被引用：無
  source_id INTEGER NOT NULL,
  -- 意圖：樣本數；求均值，判斷數據是否稀疏
  -- 引用：→ 統計自 observation 的行數 [邏輯]
  -- 被引用：無
  n         INTEGER NOT NULL,
  -- 意圖：instant / cumulative 為值之和（均值 = sum / n）；level 為「值 × 秒」的積分（均值 = sum / seconds）
  -- 引用：→ 聚合自 observation.value [邏輯]
  -- 被引用：無
  sum       REAL,
  -- 意圖：範圍圖的下界；是否有意義由 agg 決定
  -- 引用：→ 聚合自 observation.value [邏輯]
  -- 被引用：無
  min       REAL,
  -- 意圖：範圍圖的上界；是否有意義由 agg 決定
  -- 引用：→ 聚合自 observation.value [邏輯]
  -- 被引用：無
  max       REAL,
  -- 意圖：interval 為區間並集時長（睡眠時長）；level 為有讀數的時長（斷線不計）
  -- 引用：→ 由 observation.start_ms / end_ms 計算 [邏輯]
  -- 被引用：無
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
-- ===================================================================
CREATE VIRTUAL TABLE report_text USING fts5 (text, tokenize = 'trigram');

-- 唯一讀取面：已套用更正、已排除被刪除的觀測。每個點最多一條更正，只是一個主鍵 LEFT JOIN。
-- corrected 列：1 = 值來自 correction，界面可提示「已更正」並查看原值
CREATE VIEW v_observation AS
SELECT o.metric_id, o.start_ms, o.source_id, o.end_ms, o.tz_min,
       CASE WHEN c.at IS NULL THEN o.value ELSE c.value END AS value,
       o.import_id, o.detail, (c.at IS NOT NULL) AS corrected
  FROM observation o
  LEFT JOIN correction c
         ON c.metric_id = o.metric_id AND c.source_id = o.source_id AND c.start_ms = o.start_ms
 WHERE c.at IS NULL OR c.value IS NOT NULL;

-- 每日選舉：每個 (指標, 日) 只取一個來源；優先級相同時按 source_id，結果確定。
CREATE VIEW v_daily AS
SELECT metric_id, day, source_id, n, sum, min, max, seconds
  FROM (SELECT d.*, row_number() OVER (PARTITION BY d.metric_id, d.day
                                       ORDER BY s.priority, d.source_id) AS rk
          FROM daily d JOIN source s ON s.id = d.source_id)
 WHERE rk = 1;
