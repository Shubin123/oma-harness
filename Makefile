.PHONY: all build-py build-ts test-py test-ts test clean release help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

all: build-py build-ts ## Build both Python and Node.js binaries

# ---- Python ----

build-py: ## Build Python binary via PyInstaller
	cd oma-pkg && ./build_macos.sh

test-py: ## Run Python tests
	cd oma-pkg && python3 -m pytest tests/ -v --tb=short -m "not live"

lint-py: ## Lint Python source
	cd oma-pkg && python3 -m ruff check src/ tests/

typecheck-py: ## Type-check Python source
	cd oma-pkg && python3 -m mypy src/oma/ --ignore-missing-imports

# ---- TypeScript / Node.js ----

build-ts: ## Build Node.js binary via esbuild + SEA
	cd oma-ts && ./build_node.sh

test-ts: ## Compile and test TypeScript
	cd oma-ts && npm run build && npm test

lint-ts: ## Type-check TypeScript (strict)
	cd oma-ts && npx tsc --noEmit

# ---- Combined ----

test: test-py test-ts ## Run all tests

lint: lint-py lint-ts ## Lint everything

clean: ## Remove build artifacts
	rm -rf oma-pkg/build oma-pkg/dist oma-pkg/.build_cache
	rm -rf oma-ts/dist oma-ts/oma-bin oma-ts/node_modules

install-py: ## Install Python package in dev mode
	cd oma-pkg && pip install -e ".[dev]"

install-ts: ## Install Node.js dependencies
	cd oma-ts && npm install

install: install-py install-ts ## Install all dependencies

release: all ## Build release artifacts for current platform
	@echo ""
	@echo "=== Release artifacts ==="
	@echo "Python: oma-pkg/dist/"
	@ls -lh oma-pkg/dist/oma* 2>/dev/null || echo "  (none)"
	@echo "Node.js: oma-ts/oma-bin/"
	@ls -lh oma-ts/oma-bin/oma* 2>/dev/null || echo "  (none)"
	@echo ""
	@echo "To create a GitHub release, tag and push:"
	@echo "  git tag v0.2.0 && git push origin v0.2.0"
