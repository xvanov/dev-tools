.PHONY: lint format test types all

# All tool invocations go through ``.venv/bin/`` so the Makefile is reliable
# regardless of which Python is on the operator's $PATH (system pytest from
# another project, for example, would shadow the factory's tools and produce
# misleading results).

VENV := .venv/bin

lint:
	$(VENV)/ruff check .
	$(VENV)/ruff format --check .

format:
	$(VENV)/ruff format .
	$(VENV)/ruff check --fix .

types:
	$(VENV)/mypy factory

test:
	$(VENV)/pytest -q

all: lint types test
