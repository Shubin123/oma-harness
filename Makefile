.PHONY: install start dev build release test test-watch test-live check clean
install:
	bun install --frozen-lockfile
start:
	bun run start
dev:
	bun run dev
build:
	bun run build
release:
	bun run build:binary
test:
	bun run test
	bun run test:browser
test-watch:
	bun run test:watch
test-live:
	bun run test:live
check:
	bun run check
clean:
	bun tools/clean.ts
