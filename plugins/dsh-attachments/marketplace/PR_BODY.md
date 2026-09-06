## Summary

- list `WJZ-P/dsh-attachments` under UI Enhancements
- add factual English and Chinese descriptions
- register three GitHub-hosted storefront screenshots
- provide the project icon: https://raw.githubusercontent.com/WJZ-P/dsh-attachments/main/assets/markdown/attachment.svg

`dsh-attachment` adds file and folder drag-and-drop attachments to the DSH Web
UI. It contributes composer/history cards through extension slots, stores durable
attachment metadata, and materializes submitted files and directory trees into
the active workspace. Native image handling remains on the Harness image path.

## Submission checks

- [x] the standalone package declares `dsh.bundle.patch` and a Web `dsh.client` entry
- [x] `cordis.patch.yml` inserts the Host plugin row
- [x] official `@deepseek-ai/*` packages are peer dependencies
- [x] the package contains working Host and browser source plus prebuilt npm artifacts
- [ ] the new repository meets the age and commit-count requirements
- [x] `node scripts/generate-readme.mjs --check`
- [x] `npx awesome-lint README.md`
- [x] `node scripts/build-site.mjs`

The prebuilt npm package installs directly into the Web profile:

```sh
dsh plugin --profile web add dsh-attachment
```
