"""每晚全量备份 Supabase 到 CSV
v0.3 (2026-09-13 修复)：
- 分页拉取：PostgREST 单次响应被 db-max-rows 上限截断为 1000 行，
  v0.2 的 `?select=*` 单请求会在 1000 行处静默丢数据（2026-09-13 实测
  appointments 真实 1009 行、备份只拿到 1000 行）。改为 limit/offset 循环，
  有 id 列的表用 order=id.asc 保证分页顺序稳定，并按 id 去重兜底。
- 无 id 列的表（holidays/schedule_overrides/patient_master/archive_index）
  若单页恰好=1000 行会打印 WARN（提示需人工确认是否被截断）。
v0.2 (2026-08-06 修复)：
- urlopen 加 timeout=25 + 单表失败重试 3 次（防自动化环境卡死 hang）
- 每表打印进度，便于定位卡表
- 删旧备份移到 health check 通过之后（失败绝不删旧备份，保证可回滚）
- 关键表 0 行判定 FAIL（0 行极可能是 RLS/认证问题而非真没数据）
"""
import os, sys, csv, json, urllib.request, datetime, time

SUPABASE_URL = "https://duan-ortho.top/api/sb"
ADMIN_KEY = os.environ.get("ORTHO_ADMIN_KEY", "Haoyayi2026#")

TABLES = ["appointments", "checklists", "checklist_items", "checklist_templates",
          "schedule_rules", "holidays", "schedule_overrides", "patient_master",
          "patient_photos", "patient_notices", "sync_log", "reminders", "archive_index"]

# 实测(2026-08-06)：前 8 张必有数据（appointments=503 / patient_master=365 等），0 行=异常
CRITICAL_TABLES = {"appointments", "checklists", "checklist_items", "checklist_templates",
                   "schedule_rules", "holidays", "schedule_overrides", "patient_master"}
# 后 5 张真空属正常（photos/notices 新功能未启用、sync_log 未写、reminders/archive_index 未用）
BACKUP_DIR = r"D:\writting\ortho-backups"

TIMEOUT = 25          # 单次请求超时（实测最慢表 ~4s，25s 留足余量）
MAX_RETRIES = 3       # 单表失败重试次数（网络抖动防护）
PAGE = 1000           # 分页大小：与 PostgREST db-max-rows 上限对齐


def _http_get(url):
    req = urllib.request.Request(url, headers={
        "x-admin-key": ADMIN_KEY,
        "User-Agent": "Mozilla/5.0 OrthoBackup/1.0"
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode())


def _table_has_id(table):
    """探测表是否有 id 列（分页排序键）。无 id 列时 PostgREST 返回 400。"""
    try:
        _http_get(f"{SUPABASE_URL}/{table}?select=id&limit=1")
        return True
    except Exception:
        return False


def fetch_table(table):
    """分页拉取整表，规避 db-max-rows=1000 截断。"""
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            has_id = _table_has_id(table)
            order = "&order=id.asc" if has_id else ""
            rows, offset = [], 0
            while True:
                page = _http_get(
                    f"{SUPABASE_URL}/{table}?select=*&limit={PAGE}&offset={offset}{order}")
                rows.extend(page)
                if len(page) < PAGE:
                    break
                offset += PAGE
            if not has_id and len(rows) == PAGE:
                print(f"  [WARN] {table} 无 id 列且恰为 {PAGE} 行，无法分页校验，"
                      f"可能被截断", file=sys.stderr)
            if has_id:  # 稳定排序下不应重复，去重仅作兜底
                seen, uniq = set(), []
                for r in rows:
                    k = r.get("id")
                    if k in seen:
                        continue
                    seen.add(k)
                    uniq.append(r)
                rows = uniq
            return rows
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(1)
    raise last_err


def main():
    if ADMIN_KEY == "YOUR_ADMIN_KEY_HERE":
        print("[FAIL] ADMIN_KEY 未设置", file=sys.stderr)
        sys.exit(1)

    os.makedirs(BACKUP_DIR, exist_ok=True)
    today = datetime.date.today().isoformat()
    tmp_path = os.path.join(BACKUP_DIR, f".{today}-backup.csv.tmp")
    final_path = os.path.join(BACKUP_DIR, f"{today}-backup.csv")
    errors = []
    all_rows = []
    table_counts = {}

    total = len(TABLES)
    for i, tbl in enumerate(TABLES, 1):
        try:
            data = fetch_table(tbl)
            table_counts[tbl] = len(data)
            for r in data:
                r["_table"] = tbl
                all_rows.append(r)
            print(f"  [{i}/{total}] {tbl}: OK {len(data)} rows")
        except Exception as e:
            table_counts[tbl] = 0
            errors.append(f"{tbl}: {type(e).__name__}: {e}")
            print(f"  [{i}/{total}] {tbl}: ERR {type(e).__name__}: {str(e)[:100]}")

    # ---- health check（在删旧备份之前！失败绝不删旧）----
    if errors:
        print(f"[FAIL] 部分表导出失败: {', '.join(errors)}", file=sys.stderr)
        print(f"[FAIL] 已保留旧备份，未写新文件", file=sys.stderr)
        sys.exit(1)

    zero_critical = [t for t in CRITICAL_TABLES if table_counts.get(t, 0) == 0]
    if zero_critical:
        print(f"[FAIL] 关键表 0 行（疑似 RLS/认证问题，不能视为空表）: {', '.join(zero_critical)}", file=sys.stderr)
        print(f"[FAIL] 已保留旧备份，未写新文件", file=sys.stderr)
        sys.exit(1)

    for t in TABLES:
        if t not in CRITICAL_TABLES and table_counts.get(t, 0) == 0:
            print(f"[WARN] 表 {t} 0 行（属正常，功能未启用）", file=sys.stderr)

    # ---- 全部通过才写文件 ----
    keys = sorted({k for r in all_rows for k in r})
    with open(tmp_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(all_rows)

    # 原子替换 → 只在这之后才删旧备份（删旧失败仅告警，保留旧备份更安全）
    os.replace(tmp_path, final_path)
    for fn in os.listdir(BACKUP_DIR):
        if fn.endswith("-backup.csv") and fn != os.path.basename(final_path):
            try:
                os.remove(os.path.join(BACKUP_DIR, fn))
            except OSError as e:
                print(f"[WARN] 删旧备份失败（保留无害）: {fn}: {e}", file=sys.stderr)

    # --- 最终 health check ---
    file_size = os.path.getsize(final_path)
    if file_size < 100:
        print(f"[WARN] backup too small ({file_size} bytes)", file=sys.stderr)
    print(f"     size={file_size:,}B | per-table={table_counts}")
    print(f"[OK] {len(all_rows)} rows ({len(TABLES)} tables) → {final_path}")


if __name__ == "__main__":
    main()
