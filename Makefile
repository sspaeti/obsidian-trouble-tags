# Trouble Tags: build, test and release helpers.
#
#   make build                 type-check and bundle main.js
#   make test                  run the unit tests
#   make dev                   rebuild on change
#   make bump VERSION=2.0.2    set the version in package.json, manifest.json,
#                              versions.json, rebuild and commit
#   make release               tag the version in manifest.json and push main
#                              and the tag; the Release workflow then builds,
#                              attests and publishes the GitHub release
#   make release VERSION=2.0.2 bump, then release
#   make lint                  eslint with the Obsidian rules

.PHONY: build test dev lint bump release check-clean

CURRENT := $(shell node -p "require('./manifest.json').version")

build:
	npm run build

test:
	npm test

lint:
	npm run lint

dev:
	npm run dev

check-clean:
	@git diff --quiet && git diff --cached --quiet || { echo "working tree not clean, commit or stash first"; exit 1; }

bump: check-clean
	@test -n "$(VERSION)" || { echo "usage: make bump VERSION=x.y.z"; exit 1; }
	npm version $(VERSION) --no-git-tag-version
	npm run build
	git add package.json package-lock.json manifest.json versions.json main.js
	git commit -m "build: release version $(VERSION)"

release: test lint
ifneq ($(strip $(VERSION)),)
ifneq ($(VERSION),$(CURRENT))
	$(MAKE) bump VERSION=$(VERSION)
endif
endif
	@$(MAKE) --no-print-directory do-release VERSION=$$(node -p "require('./manifest.json').version")

.PHONY: do-release
do-release: check-clean
	@git rev-parse -q --verify "refs/tags/$(VERSION)" >/dev/null && { echo "tag $(VERSION) already exists"; exit 1; } || true
	git tag -a $(VERSION) -m "$(VERSION)"
	git push origin main $(VERSION)
	@echo "Tag $(VERSION) pushed. The Release workflow builds, attests and publishes it:"
	@echo "  gh run watch"
