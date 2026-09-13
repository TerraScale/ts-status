.PHONY: check test build deploy
check:
	npm ci
	npm run check
	npm test
	npm run build
	npm exec -- wrangler deploy --config dist/server/wrangler.json --dry-run
test:
	npm test
build:
	npm run build
deploy:
	npm run deploy
