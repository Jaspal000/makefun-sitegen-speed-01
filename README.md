# makefun-sitegen-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Jaspal000/makefun-sitegen-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Jaspal000/makefun-sitegen-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

solve.js reimplements the makefun-site 1.0.0 build — front matter, the Markdown subset, the template dialect, slug and collection rules, tag and index pages, and the build report — returning the identical output tree (path → file text) for every case, byte for byte. It is dependency-free and optimised for CPU: single-pass rendering, compiled templates, ASCII fast paths. main.ts is the harness driver: it reads /input/cases.json and writes /output/answers.json. Validated byte-identical on the kit's practice set and on 120 generated sites.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=30yvk1en&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
