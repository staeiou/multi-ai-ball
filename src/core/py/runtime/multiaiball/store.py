"""SQLite persistence: live writes, resume, crash tolerance.

Results are written as each call finishes, so an interrupted run keeps
everything it already got. One schema definition feeds both ``CREATE TABLE`` and
the migration that widens a database written by an older export, which is what
makes ``--resume`` safe against a bundle whose columns have changed.
"""
import json

import aiosqlite

# (column, sqlite type). Context and parameter columns are appended per trial.
BASE_COLUMNS = [
    ("task_id", "TEXT PRIMARY KEY"),
    ("config_index", "INTEGER"),
    ("model_name", "TEXT"),
    ("display_name", "TEXT"),
    ("repeat_index", "INTEGER"),
    ("prompt", "TEXT"),
    ("system_prompt", "TEXT"),
    ("success", "INTEGER"),
    ("http_status", "INTEGER"),
    ("response_headers", "TEXT"),
    ("response_data", "TEXT"),
    ("extracted", "TEXT"),
    ("reasoning", "TEXT"),
    ("parsed", "TEXT"),
    ("error", "TEXT"),
    ("duration_seconds", "REAL"),
]


BASE_NAMES = frozenset(name for name, _ in BASE_COLUMNS)


def quote(name):
    """Quote an identifier so a dataset column can be any string."""
    return '"' + str(name).replace('"', '""') + '"'


def context_column(name):
    """Column for a variable or dataset column, keeping its own name.

    A dataset column called ``prompt`` or ``error`` would otherwise land on top
    of the base column of that name -- both in the schema and in the row dict --
    and silently replace the run's own record of what was sent and what failed.
    Only the colliding names are prefixed, so ordinary columns stay readable.
    """
    return "var_" + str(name) if str(name) in BASE_NAMES else str(name)


def parameter_column(name):
    """Column for a request parameter, always prefixed.

    Parameters share a namespace with dataset columns -- an OpenAI Responses
    trial over a dataset with a ``text`` column has both -- so they are prefixed
    unconditionally rather than only on collision.
    """
    return "param_" + str(name)


class ResultStore:
    """Everything this run knows, in one table."""

    def __init__(self, path, extra_columns=()):
        self.path = path
        # Context and parameter columns arrive already namespaced by the two
        # functions above, so the only de-duplication left is repeats.
        self.columns = list(BASE_COLUMNS) + [
            (name, "TEXT") for name in dict.fromkeys(extra_columns)
            if name not in BASE_NAMES
        ]
        self._db = None

    async def open(self):
        self._db = await aiosqlite.connect(self.path)
        columns = ", ".join(f"{quote(n)} {t}" for n, t in self.columns)
        await self._db.execute(f"CREATE TABLE IF NOT EXISTS results ({columns})")
        await self._migrate()
        await self._db.commit()
        return self

    async def _migrate(self):
        """Add whatever an older database is missing, so --resume can write."""
        cursor = await self._db.execute("PRAGMA table_info(results)")
        existing = {row[1] for row in await cursor.fetchall()}
        await cursor.close()
        for name, sql_type in self.columns:
            if name not in existing:
                await self._db.execute(
                    f"ALTER TABLE results ADD COLUMN {quote(name)} {sql_type}"
                )

    async def already_done(self, task_id):
        """True only for a task that previously *succeeded*.

        A failed row is not done: an interrupted run retries it rather than
        counting it as finished.
        """
        cursor = await self._db.execute(
            "SELECT success FROM results WHERE task_id = ?", (task_id,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return bool(row and row[0])

    async def save(self, values):
        """Write one result, replacing any earlier attempt at the same task."""
        known = {name for name, _ in self.columns}
        row = {k: v for k, v in values.items() if k in known}
        for key in ("response_data", "response_headers"):
            if isinstance(row.get(key), (dict, list)):
                row[key] = json.dumps(row[key], ensure_ascii=False)
        names = ", ".join(quote(k) for k in row)
        marks = ", ".join("?" for _ in row)
        await self._db.execute(
            f"INSERT OR REPLACE INTO results ({names}) VALUES ({marks})",
            [_storable(v) for v in row.values()],
        )
        await self._db.commit()

    async def summary(self):
        cursor = await self._db.execute(
            "SELECT config_index, display_name, COUNT(*), SUM(success) "
            "FROM results GROUP BY config_index, display_name ORDER BY config_index"
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return rows

    async def close(self):
        if self._db is not None:
            await self._db.close()
            self._db = None


def _storable(value):
    """SQLite takes str/int/float/None; everything else becomes compact JSON."""
    if value is None or isinstance(value, (str, int, float, bytes)):
        return value
    if isinstance(value, bool):
        return int(value)
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)
