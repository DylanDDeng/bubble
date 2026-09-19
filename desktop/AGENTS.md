# Desktop verification data

- For agent-performed desktop verification, use `npm run desktop:qa` from the repository root (`npm run dev:qa` here). Each launch gets its own temporary desktop and Agent data. Choose an unused `PORT` when the user's dev server is running.
- `npm run dev` is the user's persistent testing environment. `npm run desktop` and `npm --prefix desktop start` use production data. Do not use either profile for your own verification or seed it with test sessions.
- Automated runtime tests must isolate both Electron `userData` and Bubble `BUBBLE_HOME`. Use the existing temporary-fixture tests as examples.
- Keep the user's running instances and existing data intact. Stop only the QA processes you started. Do not import real history or credentials into QA unless the user specifically requests it.
