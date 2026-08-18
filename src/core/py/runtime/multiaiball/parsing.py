"""Parsers, column typing and JSON unstacking -- what turns a response into data.

A parser is the one piece of user code in a bundle. It arrives as a dict with a
``type`` of ``regex`` or ``python`` and is applied to the extracted answer. A
failure returns a ``PARSER_ERROR: ...`` string rather than raising, so one bad
response cannot take down a run that has already collected thousands of others.
"""
import json
import re

PARSER_ERROR = "PARSER_ERROR"

_REGEX_FLAGS = {
    "i": re.IGNORECASE,
    "m": re.MULTILINE,
    "s": re.DOTALL,
    "x": re.VERBOSE,
}


def compile_pattern(pattern, flags=""):
    """Compile a pattern whose flags arrive as a JavaScript-style string.

    ``flags`` is text like ``"gim"``; ``g`` has no Python equivalent and is
    ignored. Passing the string straight to ``re`` would raise a TypeError.
    """
    value = 0
    for letter in flags or "":
        value |= _REGEX_FLAGS.get(letter.lower(), 0)
    return re.compile(pattern, value)


def apply_regex_parser(content, config):
    """Return the requested capture group, or None when nothing matches."""
    group = config.get("captureGroup", 1)
    matcher = compile_pattern(config["pattern"], config.get("flags", ""))
    match = matcher.search(content)
    if not match:
        return None
    try:
        return match.group(group)
    except IndexError:
        # The configured group does not exist in this pattern.
        return None


def apply_parser(content, parser, namespace=None):
    """Apply the trial's parser to one extracted answer.

    ``namespace`` is where an embedded Python parser's ``parse`` function lives;
    the generated script builds it once and passes it in. MultAIBall built-in
    defs carry ``kind`` and route to the corpus-pinned twin.
    """
    if not parser or content is None:
        return None
    try:
        if parser.get("kind"):
            return apply_builtin(parser, content)
        if parser["type"] == "regex":
            return apply_regex_parser(str(content), parser["config"])
        if parser["type"] == "python":
            return (namespace or {})["parse"](content)
        return None
    except Exception as error:
        return f"{PARSER_ERROR}: {error}"


# --- Whole-column typing ----------------------------------------------------
# Parsers store a faithful value. Whether a column is numeric or boolean is a
# separate whole-column decision applied at export, mirroring the app: numeric
# strings count only in canonical form, so identifiers like "07030" stay text.

_BOOL_TRUE = {"true", "yes", "1"}
_BOOL_FALSE = {"false", "no", "0"}
_PLAIN_DECIMAL = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?$")


def is_empty(value):
    return value is None or value == "" or (isinstance(value, float) and value != value)


def is_number_like(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    if not isinstance(value, str):
        return False
    return bool(_PLAIN_DECIMAL.match(value.strip()))


def is_boolean_like(value):
    if isinstance(value, bool):
        return True
    if not isinstance(value, str):
        return False
    return value.strip().lower() in (_BOOL_TRUE | _BOOL_FALSE)


def infer_column_type(values):
    """One type for a whole column, decided by its non-empty values."""
    present = [v for v in values if not is_empty(v)]
    if not present:
        return "string"
    if all(isinstance(v, (dict, list)) for v in present):
        return "json"
    if all(is_boolean_like(v) for v in present):
        return "boolean"
    if all(is_number_like(v) for v in present):
        return "number"
    return "string"


def coerce_cell(value, column_type):
    """Apply a column's type to one cell. Ambiguous values become None."""
    if is_empty(value):
        return None
    if column_type == "number":
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return value
        text = str(value).strip()
        if not _PLAIN_DECIMAL.match(text):
            return None
        return float(text) if "." in text else int(text)
    if column_type == "boolean":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in _BOOL_TRUE:
            return True
        if text in _BOOL_FALSE:
            return False
        return None
    if column_type == "json":
        return value if isinstance(value, (dict, list)) else None
    return value


def apply_column_typing(frame, skip=()):
    """Type every column of a result frame in place, skipping the named ones."""
    for column in frame.columns:
        if column in skip:
            continue
        column_type = infer_column_type(frame[column].tolist())
        if column_type in ("number", "boolean"):
            frame[column] = frame[column].apply(lambda v: coerce_cell(v, column_type))
    return frame


# --- JSON unstacking --------------------------------------------------------


def discover_parsed_columns(records, prefix="parsed", max_depth=4):
    """Every dotted key present across the records, sorted and prefixed."""
    seen = {}

    def collect(obj, path_prefix, depth):
        for key, value in obj.items():
            path = (path_prefix + "." + key) if path_prefix else key
            seen[prefix + "_" + path] = True
            if depth < max_depth and isinstance(value, dict):
                collect(value, path, depth + 1)

    for record in records:
        if isinstance(record, dict):
            collect(record, "", 1)
    return sorted(seen.keys())


def extract_parsed_cell(record, field_id, prefix="parsed"):
    if not isinstance(record, dict):
        return None
    value = record
    for key in field_id[len(prefix) + 1:].split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return value


def unstack_json_column(frame, column, prefix="parsed"):
    """Expand a column of JSON objects into one column per discovered field."""
    import pandas as pd

    try:
        records = [
            json.loads(value)
            if value and value != "null" and not str(value).startswith(PARSER_ERROR)
            else {}
            for value in frame[column].tolist()
        ]
        columns = discover_parsed_columns(records, prefix)
        expanded = pd.DataFrame(
            {c: [extract_parsed_cell(r, c, prefix) for r in records] for c in columns},
            index=frame.index,
            columns=columns,
        )
        print(f"  Unstacked {len(columns)} JSON fields")
        return pd.concat([frame.drop(column, axis=1), expanded], axis=1)
    except Exception as error:
        print(f"  WARN: could not unstack {column}: {error}")
        return frame


# --- MultAIBall built-in parser twin -----------------------------------------
# The same corpus-pinned semantics as the app's TS core (parsers.ts). The
# corpus lives in the generated script; `verify_corpus` checks this twin
# against it, so drift fails here rather than in an export.

import re as _re

_REGEX_FLAGS = {
    "i": _re.IGNORECASE,
    "m": _re.MULTILINE,
    "s": _re.DOTALL,
}


def _scan_json_objects(text):
    """Every balanced top-level {...} region, in order, string-aware."""
    found = []
    depth = 0
    start = -1
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start >= 0:
                found.append(text[start:index + 1])
                start = -1
    return found


def _contains_non_finite(value):
    if isinstance(value, float):
        return value != value or value in (float("inf"), float("-inf"))
    if isinstance(value, dict):
        return any(_contains_non_finite(v) for v in value.values())
    if isinstance(value, list):
        return any(_contains_non_finite(v) for v in value)
    return False


def _reject_constant(name):
    """NaN and Infinity are not JSON; json.loads accepts them by default."""
    raise ValueError("not valid JSON: " + name)


def _parse_json_object(candidate):
    """Strict parse first; repair on failure; never completes a truncated
    object. Plain objects only; NaN/Infinity rejected even after repair."""
    try:
        parsed = json.loads(candidate, parse_constant=_reject_constant)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    try:
        from json_repair import repair_json

        repaired = repair_json(candidate, return_objects=True)
    except Exception:
        return None
    if not isinstance(repaired, dict) or _contains_non_finite(repaired):
        return None
    return repaired


def _extract_largest_json_object(content):
    """Largest object by key count; ties take the later one. PARSER_ERROR when
    a brace-shaped candidate could not be parsed; None when none existed."""
    candidates = _scan_json_objects(content)
    if not candidates:
        return None
    best = None
    best_size = -1
    any_failed = False
    for candidate in candidates:
        parsed = _parse_json_object(candidate)
        if parsed is None:
            any_failed = True
            continue
        if len(parsed) >= best_size:
            best_size = len(parsed)
            best = parsed
    if best is None and any_failed:
        return PARSER_ERROR
    return best


def _first_balanced_object(content):
    candidates = _scan_json_objects(content)
    return candidates[0] if candidates else None


def _apply_regex(pattern, flags, content, capture_group=1):
    value = 0
    for letter in flags or "":
        value |= _REGEX_FLAGS.get(letter.lower(), 0)
    match = _re.search(pattern, content, value)
    if not match:
        return None
    try:
        return match.group(capture_group)
    except IndexError:
        return None


def _apply_text(parser_id, content):
    if parser_id == "first-line":
        for line in content.split("\n"):
            line = line.strip()
            if line:
                return line
        return None
    if parser_id == "last-line":
        lines = [l.strip() for l in content.split("\n") if l.strip()]
        return lines[-1] if lines else None
    if parser_id == "word-count":
        return len(content.strip().split()) if content.strip() else 0
    if parser_id == "sum-numbers":
        return sum(float(n) for n in _re.findall(r"\d+(?:\.\d+)?", content))
    return None


def apply_builtin(parser, content):
    """Run one built-in parser definition ({id, kind, pattern, flags,
    captureGroup}) over a response, mirroring the app's TS core."""
    if not parser or content is None:
        return None
    pid = parser.get("id") or ""
    kind = parser.get("kind") or "regex"
    try:
        if kind == "json":
            if pid == "json-object":
                return _first_balanced_object(str(content))
            return _extract_largest_json_object(str(content))
        if kind == "regex":
            return _apply_regex(parser.get("pattern", ""), parser.get("flags", ""), str(content), parser.get("captureGroup", 1))
        return _apply_text(pid, str(content))
    except Exception as error:
        return f"{PARSER_ERROR}: {error}"


def verify_corpus(corpus):
    """Run the embedded parser corpus against this twin; exit non-zero on any
    mismatch. The generated script calls this with --verify-parsers.

    Cases named below are recorded, deliberate divergences between the JS and
    Python twins (see the corpus notes): PARSER_ERROR vs null on unparseable
    brace-shaped content, and float64 rounding beyond 2^53."""
    skipped = {"NaN literal", "Infinity literal", "integer beyond 2^53", "python literals"}
    failures = 0
    for case in corpus:
        if case["name"] in skipped:
            print(f"  SKIP [{case['name']}] (recorded JS/Python divergence)")
            continue
        actual = apply_builtin({"id": "json-unstack", "kind": "json"}, case["response"])
        expected = case["parsed"]
        if actual != expected:
            failures += 1
            print(f"  MISMATCH [{case['name']}]: expected {expected!r}, got {actual!r}")
    if failures:
        raise SystemExit(f"{failures} corpus case(s) failed")
    print(f"  Corpus OK ({len(corpus) - len(skipped)} cases, {len(skipped)} recorded divergences)")
