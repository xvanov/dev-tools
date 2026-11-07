"""The pipeline genome — a DECLARED search space over sssf-style pipeline knobs.

Every field's legal values are a module-level constant, listed here and
nowhere else, so the search space is auditable in one place. A ``Genome`` is a
point in that space; ``validate`` is the one gate everything else goes
through — mutation, crossover, and construction from a mapped replay arm all
call it, and an out-of-space value is a raised error, never a silently
clamped one (a mutation that clamped instead of rejecting would let the
search quietly narrow itself without anyone deciding that on purpose).

The six knobs and why each is in the space (not just "a config value"):

* ``builder_model`` / ``reviewer_model`` — which model writes and which
  reviews. Ids only; nothing here calls a provider. The reviewer space
  includes the builder's OWN model as a legal choice (self-review) because
  E5b.1 (``ai_docs/research/EXPERIMENTS.md``) measured self-review as the
  arm's own null hypothesis, not a value worth excluding from the space.
* ``revision_loops`` / ``json_fix_attempts`` — the two engine-side retry
  bounds ``swebench_adapter.py`` calls ``_SSSF_LIMITS``. E5.6 found cost
  concentrating on failures through exactly this loop; the space runs
  0..3 so a genome can be searched down to "no revise loop at all" as well
  as up to the engine's measured default (2).
* ``retrieval_prepass`` — a hypothetical scout step. In the space because
  E5.5's failure taxonomy found ``wrong_place`` (never located the relevant
  code) at 7/21 unresolved cells — the one failure mode a smarter model
  doesn't fix and a retrieval step plausibly does.
* ``context_cap_tokens`` — E5.7's lever: input tokens per task spanned 170x
  across arms in the E5 campaign and re-sent context, not output, was the
  bill. ``None`` means uncapped.
"""

from __future__ import annotations

import dataclasses
import random
from typing import Any

# ── the declared search space ────────────────────────────────────────────
#
# Every one of these ids/values is either an id already in
# ``bench/swebench_adapter.py`` (``_SSSF_FLASH``, ``_SSSF_FLASH_SAIL``,
# ``_SSSF_KIMI``, ``_SSSF_CHEAP`` (DeepSeek-V3.2), ``_SSSF_STRONG``
# (gpt-5.4)) or ``None``. No id here makes a network call by existing; it is
# a string used to index a synthetic landscape (``fitness.py``'s ``mock``) or
# to look up a real recorded row (``fitness.py``'s ``replay``).
BUILDER_MODELS: tuple[str, ...] = (
    "azure/DeepSeek-V4-Flash",
    "sail/deepseek/deepseek-v4-flash-0731",
    "azure/Kimi-K2.7-Code",
    "azure/DeepSeek-V3.2",
)

# ``None`` = no reviewer (solo builder). The builder's own model is a legal
# reviewer value (self-review, E5b.1's null arm) — see the module docstring.
REVIEWER_MODELS: tuple[str | None, ...] = (
    None,
    "azure/gpt-5.4",
    "azure/Kimi-K2.7-Code",
    "azure/DeepSeek-V4-Flash",
)

# Ordinal: index order IS the neighborhood order for mutation.
REVISION_LOOPS: tuple[int, ...] = (0, 1, 2, 3)
JSON_FIX_ATTEMPTS: tuple[int, ...] = (0, 1, 2, 3)

RETRIEVAL_PREPASS: tuple[bool, ...] = (False, True)

# Ordinal, ``None`` sorts first (uncapped is the "loosest" setting, not a
# missing one). Index order is the neighborhood order for mutation.
CONTEXT_CAP_TOKENS: tuple[int | None, ...] = (None, 100_000, 300_000, 1_000_000)

# The knobs that are ORDINAL (neighborhood = adjacent index) vs CATEGORICAL
# (neighborhood = any other value; there is no "adjacent" builder model).
_ORDINAL_FIELDS = ("revision_loops", "json_fix_attempts", "context_cap_tokens")
_CATEGORICAL_FIELDS = ("builder_model", "reviewer_model", "retrieval_prepass")

_SPACE: dict[str, tuple[Any, ...]] = {
    "builder_model": BUILDER_MODELS,
    "reviewer_model": REVIEWER_MODELS,
    "revision_loops": REVISION_LOOPS,
    "json_fix_attempts": JSON_FIX_ATTEMPTS,
    "retrieval_prepass": RETRIEVAL_PREPASS,
    "context_cap_tokens": CONTEXT_CAP_TOKENS,
}

_FIELDS: tuple[str, ...] = tuple(_SPACE.keys())


class InvalidGenomeError(ValueError):
    """A genome (or a proposed mutation/crossover result) is outside the
    declared search space. Raised, never silently clamped."""


@dataclasses.dataclass(frozen=True, slots=True)
class Genome:
    builder_model: str
    reviewer_model: str | None
    revision_loops: int
    json_fix_attempts: int
    retrieval_prepass: bool
    context_cap_tokens: int | None

    def as_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    def key(self) -> tuple[Any, ...]:
        """A hashable, order-stable identity for dedup/history hashing."""
        return tuple(getattr(self, f) for f in _FIELDS)

    def replace(self, **changes: Any) -> Genome:
        return dataclasses.replace(self, **changes)


def validate(genome: Genome) -> None:
    """Raise ``InvalidGenomeError`` iff any field is outside its declared space."""
    errors = []
    for field, space in _SPACE.items():
        value = getattr(genome, field)
        if value not in space:
            errors.append(f"{field}={value!r} not in declared space {space!r}")
    if errors:
        raise InvalidGenomeError("; ".join(errors))


def is_valid(genome: Genome) -> bool:
    try:
        validate(genome)
    except InvalidGenomeError:
        return False
    return True


def random_genome(rng: random.Random) -> Genome:
    """A uniform-random point in the declared space. Always valid by construction."""
    g = Genome(**{f: rng.choice(_SPACE[f]) for f in _FIELDS})
    validate(g)
    return g


def seed_population(size: int, rng: random.Random) -> list[Genome]:
    """A diverse initial population: one genome per builder_model (cycled) with
    every other knob drawn independently, then topped up uniform-random.

    Cycling the builder guarantees the seed population is not accidentally
    homogeneous on the one knob most likely to dominate the landscape.
    """
    pop: list[Genome] = []
    for i in range(size):
        builder = BUILDER_MODELS[i % len(BUILDER_MODELS)]
        g = Genome(
            builder_model=builder,
            reviewer_model=rng.choice(REVIEWER_MODELS),
            revision_loops=rng.choice(REVISION_LOOPS),
            json_fix_attempts=rng.choice(JSON_FIX_ATTEMPTS),
            retrieval_prepass=rng.choice(RETRIEVAL_PREPASS),
            context_cap_tokens=rng.choice(CONTEXT_CAP_TOKENS),
        )
        validate(g)
        pop.append(g)
    return pop


def _neighbor_value(field: str, current: Any, rng: random.Random) -> Any:
    space = _SPACE[field]
    if len(space) == 1:
        return current
    if field in _ORDINAL_FIELDS:
        idx = space.index(current)
        candidates = [i for i in (idx - 1, idx + 1) if 0 <= i < len(space)]
        return space[rng.choice(candidates)]
    # categorical (incl. boolean toggle for retrieval_prepass): any OTHER value
    others = [v for v in space if v != current]
    return rng.choice(others)


def mutate(genome: Genome, rng: random.Random) -> Genome:
    """One-knob neighborhood move. Always returns a valid genome — the space
    a field draws its neighbor from IS the declared space, so there is no
    invalid output to clamp. ``validate`` is still called before returning:
    a future bug that widens ``_neighbor_value`` beyond ``_SPACE`` must be
    caught here, not silently accepted.
    """
    field = rng.choice(_FIELDS)
    new_value = _neighbor_value(field, getattr(genome, field), rng)
    child = genome.replace(**{field: new_value})
    validate(child)
    return child


def crossover(a: Genome, b: Genome, rng: random.Random) -> Genome:
    """Uniform crossover, per-knob: each field independently comes from
    ``a`` or ``b`` with equal probability."""
    child = Genome(**{f: (getattr(a, f) if rng.random() < 0.5 else getattr(b, f)) for f in _FIELDS})
    validate(child)
    return child
