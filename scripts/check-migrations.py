"""Syntax-check every Supabase migration without a database.

Run: python scripts/check-migrations.py   (needs `pip install pglast`)
It only proves the SQL statements parse (function bodies are left alone); it does not run anything.
Exit code 1 lists the files that do not parse.
"""
import sys
from pathlib import Path

import pglast

root = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
bad = []
for f in sorted(root.glob("*.sql")):
    sql = f.read_text()
    try:
        pglast.parse_sql(sql)
    except Exception as e:  # noqa: BLE001
        bad.append((f.name, str(e).splitlines()[0]))
print(f"{len(list(root.glob('*.sql')))} migrations checked")
for name, err in bad:
    print(f"  FAIL {name}: {err}")
sys.exit(1 if bad else 0)
