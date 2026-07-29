# meanwhile
#
# Every target here must work. If a target stops working, fix it or delete it
# in the same commit — a Makefile that lies is worse than no Makefile.

.DEFAULT_GOAL := help
.PHONY: help install dev build preview test test-watch typecheck check clean inspect

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

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

inspect: ## Report what meanwhile reads from a folder of media: make inspect DIR=~/photos
ifndef DIR
	$(error set DIR, e.g. make inspect DIR=~/Desktop/race-photos)
endif
	node scripts/inspect-media.ts "$(DIR)"

check: typecheck test ## Everything CI would run

clean: ## Remove build output and installed packages
	rm -rf dist node_modules
