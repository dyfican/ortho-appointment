"""每晚全量备份 Supabase 到 CSV"""
import os, sys, csv, json, urllib.request, datetime

# ⚠️ 段医生：替换为 Supabase Dashboard → Settings → API → anon public 的真 key
SUPABASE_URL = "https://duan-ortho.top/api/sb"
ADMIN_KEY = os.environ.get("ORTHO_ADMIN_KEY", "Haoyayi2026#")

TABLES = ["appointments", "checklists", "checklist_items", "patient_photos", "patient_notices"]
BACKUP_DIR = r"D:\writting\ortho-backups"

def fetch_table(table):
    url = f"{SUPABASE_URL}/{table}?select=*"
    req = urllib.request.Request(url, headers={
        "x-admin-key": ADMIN_KEY,
        "User-Agent": "Mozilla/5.0 OrthoBackup/1.0"
    })
    return json.loads(urllib.request.urlopen(req).read().decode())

def main():
    if ADMIN_KEY == "YOUR_ADMIN_KEY_HERE":
        print("[FAIL] ADMIN_KEY 未设置")
        sys.exit(1)

    os.makedirs(BACKUP_DIR, exist_ok=True)
    today = datetime.date.today().isoformat()
    tmp_path = os.path.join(BACKUP_DIR, f".{today}-backup.csv.tmp")
    final_path = os.path.join(BACKUP_DIR, f"{today}-backup.csv")
    errors = []

    all_rows = []
    for tbl in TABLES:
        try:
            data = fetch_table(tbl)
            for r in data:
                r["_table"] = tbl
                all_rows.append(r)
        except Exception as e:
            errors.append(f"{tbl}: {e}")

    if errors:
        print(f"[FAIL] 部分表导出失败: {', '.join(errors)}", file=sys.stderr)
        sys.exit(1)

    keys = sorted({k for r in all_rows for k in r})
    with open(tmp_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(all_rows)

    # 原子替换：先写临时文件 →  rename →  删旧
    os.replace(tmp_path, final_path)
    for fn in os.listdir(BACKUP_DIR):
        if fn.endswith("-backup.csv") and fn != os.path.basename(final_path):
            os.remove(os.path.join(BACKUP_DIR, fn))

    # --- health check ---
    file_size = os.path.getsize(final_path)
    if file_size < 100:
        print(f"[WARN] backup too small ({file_size} bytes)", file=sys.stderr)
    table_counts = {}
    for r in all_rows:
        t = r.get("_table", "?")
        table_counts[t] = table_counts.get(t, 0) + 1
    for tbl in TABLES:
        if table_counts.get(tbl, 0) == 0:
            print(f"[WARN] table {tbl} has 0 rows", file=sys.stderr)
    print(f"     size={file_size:,}B | per-table={table_counts}")
    print(f"[OK] {len(all_rows)} rows ({len(TABLES)} tables) → {final_path}")

if __name__ == "__main__":
    main()
