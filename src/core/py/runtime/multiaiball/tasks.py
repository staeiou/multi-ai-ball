"""Where the prompts come from.

The two kinds of Auditomatic trial differ only here. A template trial expands
variables into a Cartesian product; a spreadsheet trial reads rows from a
Parquet file. Everything downstream -- requests, retries, storage, parsing,
export -- is identical, so it is written once and takes a task source.

A task source yields dicts with a stable ``task_id``, the ``prompt`` to send,
and the ``context`` (variables or row values) recorded alongside the result.
"""
import datetime
import itertools
import json
import math
import re
from decimal import Decimal

# The name may hold anything but a brace, and is trimmed. Excluding `{` as well
# as `}` is what makes `{{{a}}}` the inner placeholder with a literal brace
# either side, rather than reading `{a` as the name.
_PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}")


def normalize_binding_value(value):
    """One value, as the characters that appear in the prompt.

    This deliberately does not use ``str``. The app renders the same prompts in
    TypeScript for live execution, preview, token counting and cost, and the
    two runtimes disagree by default: ``str(True)`` is "True" here and "true"
    there, ``str(1.0)`` is "1.0" here and "1" there. A prompt should not reveal
    which language rendered it, and a reproduction that differs from the run it
    reproduces is not a reproduction.

    The TypeScript side of this contract is
    ``src/shared/prompt-template/normalize.ts``, and
    ``__tests__/python-parity.test.ts`` runs both over the same fixtures.
    """
    # Parquet columns arrive as numpy scalars, which are not Python ints or
    # bools. Unwrap before dispatching on type.
    if hasattr(value, "item") and not isinstance(value, (str, bytes, list, dict, tuple)):
        try:
            value = value.item()
        except Exception:
            pass

    if value is None:
        return ""

    # NaN and pandas NaT both fail self-equality. An empty Parquet cell arrives
    # this way, and it is an absent value, not the word "nan".
    try:
        if value != value:
            return ""
    except Exception:
        pass

    # bool before int: bool is a subclass of int in Python.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return "" if not math.isfinite(value) else _format_double(value)
    if isinstance(value, datetime.datetime):
        if value.tzinfo is not None:
            value = value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
        return "%s.%03dZ" % (value.strftime("%Y-%m-%dT%H:%M:%S"), value.microsecond // 1000)
    if isinstance(value, datetime.date):
        return value.strftime("%Y-%m-%dT00:00:00.000Z")
    if isinstance(value, (list, tuple, dict)):
        try:
            return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError):
            return ""
    return ""


def _format_double(value):
    """A float, spelled the way ECMAScript's Number::toString spells it.

    Python and JavaScript both produce shortest round-trip digits, but they
    switch to exponential notation at different magnitudes: Python at 1e16 and
    1e-5, JavaScript at 1e21 and 1e-7. So ``repr(1e17)`` is "1e+17" here and
    "100000000000000000" there. Taking Python's digits and applying JavaScript's
    notation rules makes the two agree across the whole finite range rather than
    on a handful of tested magnitudes.
    """
    if value == 0:
        return "0"  # also collapses -0.0, as String(-0) does

    sign, digits, exponent = Decimal(repr(value)).normalize().as_tuple()
    digits = "".join(str(d) for d in digits)
    prefix = "-" if sign else ""
    # value == 0.digits * 10**point, per the spec's n
    point = exponent + len(digits)

    if len(digits) <= point <= 21:
        return prefix + digits + "0" * (point - len(digits))
    if 0 < point <= 21:
        return prefix + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return prefix + "0." + "0" * -point + digits
    mantissa = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    return "%s%se%s%d" % (prefix, mantissa, "+" if point > 0 else "-", abs(point - 1))


def fill(template, values):
    """Substitute ``{{name}}`` placeholders, tolerating inner whitespace.

    A name that has a value substitutes that value's normalized text -- an
    empty spreadsheet cell arrives as ``None`` or as a float ``nan``, and
    neither of those words belongs in a prompt.

    A name that is not a variable at all is left as-is rather than blanked, so a
    typo stays visible in the sent prompt instead of silently producing a
    truncated one. Note this is a different question from an empty cell, with
    the opposite answer: the typo has no binding and stays visible, the empty
    cell has one and renders as nothing.
    """
    def replace(match):
        key = match.group(1).strip()
        # `{{}}` and `{{  }}` are literal text: nothing can be keyed on nothing.
        if not key or key not in values:
            return match.group(0)
        return normalize_binding_value(values[key])

    return _PLACEHOLDER.sub(replace, template)


SYSTEM_SENTINEL = "{{SYSTEM}}"
PROMPT_SENTINEL = "{{PROMPT}}"


def substitute_sentinels(body, system, prompt):
    """Replace the whole-string sentinels in a body skeleton with rendered text.

    Mirrors the app's providers/shapes.ts substitute(): only a string value that
    IS the sentinel is replaced, never a sentinel embedded inside other text, so
    prompt content can never be mistaken for markup. The legacy
    ``{{SYSTEM_PROMPT}}`` spelling from earlier bundles is accepted too.
    """
    if isinstance(body, str):
        if body == SYSTEM_SENTINEL or body == "{{SYSTEM_PROMPT}}":
            return system if system is not None else ""
        if body == PROMPT_SENTINEL:
            return prompt
        return body
    if isinstance(body, list):
        return [substitute_sentinels(item, system, prompt) for item in body]
    if isinstance(body, dict):
        return {key: substitute_sentinels(value, system, prompt) for key, value in body.items()}
    return body


def attr_column(variable_name, attribute_name):
    """The result column for one attribute of one variable.

    Defined once because two places need it and they must agree: the column
    list and the row that fills it. A column named in one and filled under
    another spelling is an empty column, which reads as "this value was never
    recorded" rather than as a bug.
    """
    return "attr_" + variable_name + "__" + attribute_name


class TemplateTasks:
    """Every combination of the configured variables, in declaration order.

    ``attributes`` is optional and positional: ``attributes[name][i]`` describes
    ``variables[name][i]``. Those keys become ``attr_<variable>__<key>`` columns
    beside the value, which is what makes a list like "names labelled by
    perceived gender" analysable after the run. Indexing by position rather than
    by value keeps a repeated value from taking the wrong label.

    The separator is doubled because both halves are names their author chose:
    with a single one, variable ``model_size`` with attribute ``b`` and variable
    ``model`` with attribute ``size_b`` produce the same column, and one of them
    silently wins. This matches the app's own export headers.
    """

    def __init__(self, template, variables, attributes=None, system_prompt=None, repeats=1):
        self.template = template
        self.variables = variables
        self.attributes = attributes or {}
        self.system_prompt = system_prompt
        self.repeats = max(1, repeats)

    @property
    def attribute_keys(self):
        """``{variable: [key, ...]}`` for the variables that carry attributes."""
        keys = {}
        for name, items in self.attributes.items():
            found = {}
            for item in items:
                found.update(dict.fromkeys(item or ()))
            if found:
                keys[name] = sorted(found)
        return keys

    @property
    def context_columns(self):
        return list(self.variables) + [
            attr_column(name, key)
            for name, keys in self.attribute_keys.items()
            for key in keys
        ]

    def _attributes_at(self, name, index):
        items = self.attributes.get(name) or ()
        return (items[index] if index < len(items) else None) or {}

    def __iter__(self):
        names = list(self.variables)
        value_lists = [list(self.variables[name]) for name in names]
        keys = self.attribute_keys
        indices = [range(len(values)) for values in value_lists]

        for combo_index, positions in enumerate(
            itertools.product(*indices) if names else [()]
        ):
            # Only the values are substituted into the prompt; the attributes
            # describe the run, they are not part of what was asked.
            values = {name: value_lists[i][p] for i, (name, p) in enumerate(zip(names, positions))}
            context = dict(values)
            for name, position in zip(names, positions):
                found = self._attributes_at(name, position)
                for key in keys.get(name, ()):
                    context[attr_column(name, key)] = found.get(key)

            for repeat in range(self.repeats):
                yield {
                    "task_id": f"combo{combo_index}_r{repeat}",
                    "prompt": fill(self.template, values),
                    "system_prompt": (
                        fill(self.system_prompt, values) if self.system_prompt else None
                    ),
                    "context": context,
                    "repeat_index": repeat,
                }


class ParquetTasks:
    """One task per dataset row, with ``{{column}}`` filled from that row."""

    def __init__(self, pattern, path="data.parquet", system_prompt=None, repeats=1):
        self.pattern = pattern
        self.path = path
        self.system_prompt = system_prompt
        self.repeats = max(1, repeats)
        self._frame = None

    @property
    def frame(self):
        if self._frame is None:
            import pandas as pd

            self._frame = pd.read_parquet(self.path)
        return self._frame

    @property
    def context_columns(self):
        return list(self.frame.columns)

    def __iter__(self):
        for row_index, row in enumerate(self.frame.to_dict("records")):
            for repeat in range(self.repeats):
                yield {
                    "task_id": f"row{row_index}_r{repeat}",
                    "prompt": fill(self.pattern, row),
                    "system_prompt": (
                        fill(self.system_prompt, row) if self.system_prompt else None
                    ),
                    "context": row,
                    "repeat_index": repeat,
                }


class RowsTasks:
    """One task per embedded row dict, with ``{{column}}`` filled from that row.

    MultAIBall's sheet runs embed the rows in the script itself (sheets are
    never persisted), so this is the ParquetTasks shape without the file.
    """

    def __init__(self, pattern, rows, system_prompt=None, repeats=1):
        self.pattern = pattern
        self.rows = rows
        self.system_prompt = system_prompt
        self.repeats = max(1, repeats)

    @property
    def context_columns(self):
        seen = {}
        for row in self.rows:
            for key in row or {}:
                seen[key] = True
        return list(seen)

    def __iter__(self):
        for row_index, row in enumerate(self.rows):
            for repeat in range(self.repeats):
                yield {
                    "task_id": f"row{row_index}_r{repeat}",
                    "prompt": fill(self.pattern, row),
                    "system_prompt": (
                        fill(self.system_prompt, row) if self.system_prompt else None
                    ),
                    "context": row,
                    "repeat_index": repeat,
                }
