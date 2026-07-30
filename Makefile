# meanwhile
#
# Every target here must work. If a target stops working, fix it or delete it
# in the same commit — a Makefile that lies is worse than no Makefile.

.DEFAULT_GOAL := help
.PHONY: help install dev build preview test test-watch typecheck check clean inspect check-test-count check-quotes release

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-17s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (run once, and after pulling changes)
	npm install

dev: ## Run the site locally at http://localhost:5173
	npm run dev

build: ## Type-check and build the static site into dist/
	npm run build

preview: ## Serve the built site from dist/ to check it before deploying
	npm run preview

test: ## Run all tests once
	npm run test

test-watch: ## Re-run tests as files change
	npm run test:watch

typecheck: ## Type-check without building
	npm run typecheck

# The Node floor is checked HERE and nowhere else, because this is the only
# target that needs it: inspect-media.ts runs as TypeScript with no build
# step, which needs Node 22.18+. package.json's `engines` only warns (npm
# installs anyway), so without this the failure is a cryptic
# `Unknown file extension ".ts"`. See scripts/require-node.mjs.
inspect: ## Report what meanwhile reads from a folder of media: make inspect DIR=~/photos
ifndef DIR
	$(error set DIR, e.g. make inspect DIR=~/Desktop/race-photos)
endif
	@node scripts/require-node.mjs
	node scripts/inspect-media.ts "$(DIR)"

check-test-count: ## Confirm CLAUDE.md's "NNN tests pass" line matches the suite
	node scripts/check-test-count.mjs

check-quotes: ## Confirm every owner quote in every tracked .md is in PROMPTS.md verbatim
	node scripts/check-owner-quotes.mjs

check: typecheck test check-test-count check-quotes ## Type-check, test, and check the docs' test count and owner quotes

clean: ## Remove build output and installed packages
	rm -rf dist node_modules

# Deliberately refuses rather than fixing anything up. CHANGELOG.md,
# package.json and the tags drift apart silently otherwise, and a tag pointing
# at a version the changelog does not describe is worse than no tag at all.
release: ## Tag a release: make release VERSION=0.1.0
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=0.1.0"; exit 1; }
	@grep -q "^## $(VERSION) " CHANGELOG.md \
		|| { echo "CHANGELOG.md has no '## $(VERSION) ...' entry"; exit 1; }
	@node -e 'const v=require("./package.json").version; if (v!==process.argv[1]) { console.error(`package.json says $${v}, not $${process.argv[1]}`); process.exit(1); }' $(VERSION)
# package-lock.json carries the version twice and npm only rewrites it on an
# install, so bumping package.json by hand leaves it behind: the lockfile
# still said 0.1.0 at 0.3.0, three releases stale. Fix with
# `npm install --package-lock-only`.
	@node -e 'const l=require("./package-lock.json"); const w=[["package-lock.json .version",l.version],["package-lock.json packages[\"\"].version",l.packages&&l.packages[""]&&l.packages[""].version]]; const bad=w.filter(([,v])=>v!==process.argv[1]); if (bad.length) { for (const [k,v] of bad) console.error(`$${k} says $${v}, not $${process.argv[1]} — run: npm install --package-lock-only`); process.exit(1); }' $(VERSION)
	@test -z "$$(git status --porcelain)" \
		|| { echo "working tree is dirty — commit first"; exit 1; }
	@git rev-parse "v$(VERSION)" >/dev/null 2>&1 \
		&& { echo "tag v$(VERSION) already exists"; exit 1; } || true
	$(MAKE) check
	git tag -a "v$(VERSION)" -m "$(VERSION)"
	@echo
	@echo "Tagged v$(VERSION). To publish it:"
	@echo "  git push origin main && git push origin v$(VERSION)"
