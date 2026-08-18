"""MultAIBall reproduction runner.

A generated ``experiment.py`` is data plus one call:

    from multiaiball import run, RowsTasks

    MODELS = [...]
    run(MODELS, RowsTasks(PROMPT_TEMPLATE, ROWS), parser=PARSER)

Everything that is the same for every experiment lives here, so the generated
script stays short enough to read and edit.

Based on the Auditomatic Lite reproduction runner (same license lineage), with
two MultAIBall additions: RowsTasks for embedded sheet rows, and the
built-in parser twin with corpus verification (``--verify-parsers``).
"""
from .http import ApiAttemptError, RetryPolicy, get_value_at_path
from .parsing import apply_builtin, apply_parser, unstack_json_column, verify_corpus
from .runner import run
from .tasks import ParquetTasks, RowsTasks, TemplateTasks, fill

__all__ = [
    "run",
    "TemplateTasks",
    "ParquetTasks",
    "RowsTasks",
    "RetryPolicy",
    "ApiAttemptError",
    "apply_parser",
    "apply_builtin",
    "unstack_json_column",
    "verify_corpus",
    "get_value_at_path",
    "fill",
]