.PHONY: all build build-py build-ts test test-py test-ts lint lint-py lint-ts \
        typecheck-py clean release install install-py install-ts help

# Every build target delegates to tools/build.py, which is the one build
# implementation and runs the same way on Linux, macOS and Windows. On Windows,
# where make is usually absent, run those commands directly:
#     python tools/build.py --help

PYTHON ?= python3

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

all: build ## Build both binaries for this platform

# ---- build ----

build: ## Build the Python and Node binaries into dist/
	$(PYTHON) tools/build.py

build-py: ## Build the Python binary only
	$(PYTHON) tools/build.py --target python

build-ts: ## Build the Node binary only
	$(PYTHON) tools/build.py --target node

release: ## Build every artifact for this platform, wheel and sdist included
	$(PYTHON) tools/build.py --clean --wheel
	@echo ""
	@echo "Artifacts in dist/. To publish, tag and push:"
	@echo "  git tag v0.2.0 && git push origin v0.2.0"

# ---- test ----

test: test-py test-ts ## Run all tests

test-py: ## Run Python tests
	cd oma-pkg && $(PYTHON) -m pytest tests/ -v --tb=short -m "not live"

test-ts: ## Compile and test TypeScript
	cd oma-ts && npm run build && npm test

# ---- lint ----

lint: lint-py typecheck-py lint-ts ## Lint and type-check everything

lint-py: ## Lint Python source
	cd oma-pkg && $(PYTHON) -m ruff check src/ tests/

typecheck-py: ## Type-check Python source
	cd oma-pkg && $(PYTHON) -m mypy src/oma/ --ignore-missing-imports

lint-ts: ## Type-check TypeScript (strict)
	cd oma-ts && npx tsc --noEmit

# ---- housekeeping ----

install: install-py install-ts ## Install all dependencies

install-py: ## Install the Python package in dev mode
	cd oma-pkg && pip install -e ".[dev]"

install-ts: ## Install Node dependencies
	cd oma-ts && npm install

clean: ## Remove build artifacts
	rm -rf dist .build_cache
	rm -rf oma-pkg/build oma-pkg/dist
	rm -rf oma-ts/dist oma-ts/oma-bin oma-ts/node_modules
