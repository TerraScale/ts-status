AI IS NOT ALLOWED TO EDIT THIS FILE ONLY HUMANS CAN!

# Rules

## Stack
- Vite (vite-plus) with the Cloudflare Vite plugin
- TypeScript Cloudflare Worker rendering HTML on the server, no frontend framework
- Cloudflare D1
- Plain CSS with the ts-dashboard design system tokens, bundled by Lightning CSS

## Develop
- Always create a feature called feat/{feature_name} fix/{fix_name} and then we create a PR into main when the work is ready to be merged when pushing and creating the pull request make sure that the linter has no errors and that all tests passes, when creating pull request send the link of that PR to the user.
- If the user requests a preview url to check the work that is current made you need to start the dev env and send the user a tailscale dns to access it and test if it works before sending to the user if it doesnt work fix it
- Do not use worktrees
- When running a dev server it must always be accesible via the tailscale net and it must have hmr turned for really fast development
