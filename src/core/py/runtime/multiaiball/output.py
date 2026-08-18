"""Writing results out, in every format the app offers.

The database is the record of the run; these are convenience renderings of it.
Text formats stream; Excel and Parquet need the frame in memory.
"""
import json
import sqlite3

from .parsing import apply_column_typing, unstack_json_column

EXTENSIONS = {
    "csv": ".csv",
    "tsv": ".tsv",
    "json": ".json",
    "jsonl": ".jsonl",
    "excel": ".xlsx",
    "parquet": ".parquet",
}

# Columns that must stay text however they look: an id like "07030" is not a
# number, and a stored JSON blob is not a boolean.
NEVER_TYPED = ("task_id", "prompt", "system_prompt", "response_data", "response_headers")

_XML_BAD = {
    c: 0xFFFD
    for c in [
        *range(0x00, 0x09), 0x0B, 0x0C, *range(0x0E, 0x20),
        *range(0xD800, 0xE000), 0xFFFE, 0xFFFF,
    ]
}


def sanitize_xlsx_text(value):
    """Replace characters XML 1.0 forbids, which openpyxl's writer rejects.

    Tab, newline and carriage return are kept; non-strings pass through.
    """
    return value.translate(_XML_BAD) if isinstance(value, str) else value


def output_filename(db_path, fmt, override=None):
    if override:
        return override
    stem = db_path.rsplit("results_", 1)[-1].rsplit(".db", 1)[0] if "results_" in db_path else "output"
    return f"results_{stem}{EXTENSIONS[fmt]}"


def read_frame(db_path, unstack_column=None):
    """Load the results table into a typed pandas frame."""
    import pandas as pd

    with sqlite3.connect(db_path) as connection:
        frame = pd.read_sql_query("SELECT * FROM results", connection)

    if unstack_column and unstack_column in frame.columns:
        frame = unstack_json_column(frame, unstack_column)

    return apply_column_typing(frame, skip=NEVER_TYPED)


def write(frame, path, fmt):
    """Render a frame to one of the supported formats."""
    if fmt == "csv":
        frame.to_csv(path, index=False)
    elif fmt == "tsv":
        frame.to_csv(path, index=False, sep="\t")
    elif fmt == "json":
        frame.to_json(path, orient="records", indent=2, force_ascii=False)
    elif fmt == "jsonl":
        with open(path, "w", encoding="utf-8") as handle:
            for record in frame.to_dict("records"):
                handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    elif fmt == "excel":
        # Column-wise Series.map, not DataFrame.map: the latter only exists in
        # pandas 2.1+, and requirements.txt allows 2.0.
        frame.apply(lambda column: column.map(sanitize_xlsx_text)).to_excel(path, index=False)
    elif fmt == "parquet":
        frame.to_parquet(path, index=False)
    else:
        raise ValueError(f"Unknown output format: {fmt}")
    return path
